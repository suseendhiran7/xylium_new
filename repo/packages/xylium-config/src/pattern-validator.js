'use strict';

/**
 * Static privacy gate for custom SDK pattern modules.
 *
 * Moved unchanged from node_app/tools/validate-custom-pattern.js so the SDK's
 * /cp route, the CLI, and the Admin Application all run the SAME rules.
 * Not a security boundary against a determined, obfuscating author: approved
 * patterns still need human review.
 */

const acorn = require('acorn');
const walk = require('acorn-walk');

// ---------------------------------------------------------------------------
// 1. Structural check: must be a self-registering module, same shape as
//    every built-in pattern file.
// ---------------------------------------------------------------------------
const MODULE_WRAPPER_RE =
  /\(window\.XyliumBFModules\s*=\s*window\.XyliumBFModules\s*\|\|\s*\[\]\)\.push\(\s*function\s*\(\s*core\s*\)\s*\{/;

// ---------------------------------------------------------------------------
// 2. User-data-capture rules. Each rule inspects the AST and pushes a
//    violation `{ rule, line, message }` when it fires. ANY violation blocks
//    the submission — this is deliberately strict, not a "score".
// ---------------------------------------------------------------------------
const FIELD_LIKE_NAMES = /^(target|el|elem|element|field|input|node|e|ev|evt)$/i;
const XYLIUM_KEY_RE = /^xylium_/;

// Recognisable PII shapes. Presence of a matching regex literal is treated
// as strong intent to extract PII, regardless of what it's used for.
const PII_REGEX_MARKERS = [
  /\\d\{3\}.{0,3}\\d\{2\}.{0,3}\\d\{4\}/, // SSN-shaped
  /\\d\{4\}.{0,3}\\d\{4\}.{0,3}\\d\{4\}.{0,3}\\d\{4\}/, // card-shaped
  /@.*\\\./, // email-shaped
];

function analyze(sourceCode) {
  const violations = [];

  if (!MODULE_WRAPPER_RE.test(sourceCode)) {
    violations.push({
      rule: 'structure',
      line: 1,
      message:
        'Submission is not wrapped as `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) { ... });`. ' +
        'Every pattern file must self-register this way so load order stays independent.',
    });
  }

  let ast;
  try {
    ast = acorn.parse(sourceCode, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (e) {
    violations.push({ rule: 'syntax', line: e.loc ? e.loc.line : 1, message: `Not valid JavaScript: ${e.message}` });
    return violations; // can't walk a broken AST
  }

  function lineOf(node) {
    return sourceCode.slice(0, node.start).split('\n').length;
  }

  walk.simple(ast, {
    // Rule A: reading `.value` off anything field/element/event-shaped.
    // This is exactly how you'd read what the user actually typed/selected —
    // vs. the SDK's own pattern files, which only ever read timing, key
    // codes, and coordinates off the same events.
    MemberExpression(node) {
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'value'
      ) {
        const objName =
          node.object.type === 'Identifier'
            ? node.object.name
            : node.object.type === 'MemberExpression' && node.object.property.type === 'Identifier'
            ? node.object.property.name
            : null;
        if (!objName || FIELD_LIKE_NAMES.test(objName) || /target/i.test(sourceCode.slice(node.start - 20, node.start))) {
          violations.push({
            rule: 'field-value-read',
            line: lineOf(node),
            message: `Reads ".value" off "${objName || '<expr>'}" — this captures what the user actually typed/selected, not just behavior.`,
          });
        }
      }

      // Rule B: document.cookie (read or write).
      if (
        !node.computed &&
        node.object.type === 'Identifier' &&
        node.object.name === 'document' &&
        node.property.type === 'Identifier' &&
        node.property.name === 'cookie'
      ) {
        violations.push({ rule: 'cookie-access', line: lineOf(node), message: 'Accesses document.cookie.' });
      }

      // Rule C: innerText / textContent / innerHTML — rendered page content.
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        ['innerText', 'textContent', 'innerHTML'].includes(node.property.name)
      ) {
        violations.push({
          rule: 'content-read',
          line: lineOf(node),
          message: `Reads "${node.property.name}" — captures rendered page/element content.`,
        });
      }

      // Rule D: InputEvent.data — the actual character(s) just typed.
      if (
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'data' &&
        /^(e|ev|evt|event)$/i.test(node.object.type === 'Identifier' ? node.object.name : '')
      ) {
        violations.push({
          rule: 'input-data-read',
          line: lineOf(node),
          message: 'Reads InputEvent.data — this is the literal character(s) the user typed.',
        });
      }
    },

    // Rule E: localStorage / sessionStorage access with a non-xylium key
    // (reading/writing the host site's own stored data instead of the
    // SDK's own namespaced keys).
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        (callee.object.name === 'localStorage' || callee.object.name === 'sessionStorage') &&
        callee.property.type === 'Identifier' &&
        ['getItem', 'setItem'].includes(callee.property.name)
      ) {
        const keyArg = node.arguments[0];
        const literalKey = keyArg && keyArg.type === 'Literal' ? String(keyArg.value) : null;
        if (!literalKey || !XYLIUM_KEY_RE.test(literalKey)) {
          violations.push({
            rule: 'storage-access',
            line: lineOf(node),
            message: `${callee.object.name}.${callee.property.name}("${literalKey || '<dynamic key>'}") touches storage outside the SDK's own "xylium_" namespace.`,
          });
        }
      }

      // Rule F: clipboard content read (getData) — vs. the built-in
      // clipboard module, which only records that a copy/paste happened.
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'getData'
      ) {
        violations.push({ rule: 'clipboard-content-read', line: lineOf(node), message: 'Calls .getData(...) — reads actual clipboard content.' });
      }

      // Rule G: any network call that bypasses core.pushEvent/pushCriticalEvent
      // (own fetch/XHR/WebSocket/sendBeacon = an independent exfiltration path).
      const NETWORK_CALLEES = new Set(['fetch', 'XMLHttpRequest', 'WebSocket']);
      if (callee.type === 'Identifier' && NETWORK_CALLEES.has(callee.name)) {
        violations.push({ rule: 'bypass-transport', line: lineOf(node), message: `Calls ${callee.name}(...) directly instead of core.pushEvent/pushCriticalEvent — bypasses the vetted transport & consent gate.` });
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'navigator' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'sendBeacon'
      ) {
        violations.push({ rule: 'bypass-transport', line: lineOf(node), message: 'Calls navigator.sendBeacon(...) directly instead of going through core\'s transport.' });
      }
    },

    // Rule H: PII-shaped regex literals anywhere in the module.
    // Rule G (constructors): `new XMLHttpRequest()` / `new WebSocket(...)` are
    // NewExpressions, not CallExpressions, so the check above never saw them.
    NewExpression(node) {
      const callee = node.callee;
      const NETWORK_CONSTRUCTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);
      if (callee.type === 'Identifier' && NETWORK_CONSTRUCTORS.has(callee.name)) {
        violations.push({ rule: 'bypass-transport', line: lineOf(node), message: `Creates new ${callee.name}(...) instead of using core.pushEvent/pushCriticalEvent — bypasses the vetted transport & consent gate.` });
      }
    },

    Literal(node) {
      if (node.regex) {
        const pattern = node.regex.pattern;
        if (PII_REGEX_MARKERS.some((re) => re.test(pattern))) {
          violations.push({ rule: 'pii-regex', line: lineOf(node), message: `Regex /${pattern}/ matches the shape of PII (SSN/card/email) — looks intended to extract it.` });
        }
      }
    },
  });

  return violations;
}

module.exports = { analyze, MODULE_WRAPPER_RE };
