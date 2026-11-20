'use strict';

/**
 * Admin-supplied regexes run on every /collect event, so a catastrophic
 * backtracking pattern would stall ingestion. This is a conservative screen,
 * not a proof: it rejects patterns that don't compile and the classic
 * nested-quantifier shapes such as (a+)+, (a*)*, (a|aa)+ and (.*)*.
 *
 * @param {string} source
 * @returns {string|null} a problem description, or null when acceptable
 */
function safeRegexSource(source) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, 'i');
  } catch (e) {
    return `Not a valid regular expression: ${e.message}`;
  }
  // A group that ends in a quantifier and is itself quantified.
  if (/\((?:[^()\\]|\\.)*[+*}]\)\s*[+*{]/.test(source)) {
    return 'Nested quantifier (e.g. "(a+)+") can cause catastrophic backtracking';
  }
  // A quantified group containing alternatives where one branch is a prefix of another.
  const alt = /\(((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*)\)\s*[+*{]/.exec(source);
  if (alt) {
    const branches = alt[1].split('|');
    for (const a of branches) {
      for (const b of branches) {
        if (a !== b && a && b.startsWith(a)) {
          return 'Quantified alternation with overlapping branches can cause catastrophic backtracking';
        }
      }
    }
  }
  return null;
}

module.exports = { safeRegexSource };
