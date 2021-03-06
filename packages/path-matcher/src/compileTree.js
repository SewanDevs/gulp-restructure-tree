import warn from './helpers/warn';
import {
    not,
    last,
    init,
    flatten,
    dropLast,
    interleave,
    mergeConsecutive,
    keepDifference,
    removeTrailing,
    AdHocTree
} from 'path-matcher-utils';


/* =Tree compilation
 * ------------------------------------------------------------ */

const STRING_TESTS = {
    REGEXP: /^\/.*\/$/,
    ARRAY: /([^\\]|^),/,
    REGEXP_CHARS: /([.\]\[)(|^$?])/g,
    GLOBSTAR: /^(\*\*)(.*)/,
    STAR: /([^\\]|^)\*/g,
};

/**
 * @returns {boolean} true if tree node is a branch (path segment), false if
 *   it's a leaf (destination).
 */
function isPathMatchingTreeBranch(val) {
    return typeof val === 'object' && val !== null;
}

export function isSolidPathSegment(segment) {
    return ![STRING_TESTS.REGEXP,
             STRING_TESTS.STAR,
             STRING_TESTS.ARRAY].some(t => t.test(segment));
}

export const isCapturingPathSegment = not(isSolidPathSegment);

/** Escape special RegExp characters except '*' */
const escapeRegExpChars = s => s.replace(STRING_TESTS.REGEXP_CHARS, '\\$1');

/** Transform globs into RegExp string */
function globsToRegExpStr(str) {
    return str.split(STRING_TESTS.GLOBSTAR)
            // => [ theWholeTextIfThereIsNoGlobstar, "**", everythingAfter ]
            .map((v, i) =>
                (i + 1) % 2 === 0 ? // (**) part
                                    // Replace unescaped '**' glob
                    v.replace(STRING_TESTS.GLOBSTAR, (_match, _p1, p2) =>
                        `([^\\/]+\/+)*${p2 ? `[^\\/]*${p2}` : ''}`)
                    : (i + 1) % 3 === 0 ? // (everythingElse) part
                        (v ? `[^\\/]*${v}` : '')
                    : // Else
                    // Replace unescaped '*' glob
                    v.replace(STRING_TESTS.STAR, '$1([^\\/]*)'))
            .join('');
}

const _transformSegment = s => globsToRegExpStr(escapeRegExpChars(s));

const arrayToORRegExpStr = ss => `(${ss.join('|')})`;

/**
 * Prepare string to be passed through RegExp constructor while transforming
 *   glob patterns.
 */
function preparePatternStringSegment(str) {
    if (STRING_TESTS.ARRAY.test(str)) {
        const els = str.replace(/([^\\]),/g, "$1$1,")
                       .split(/[^\\],/);
        return arrayToORRegExpStr(els.map(_transformSegment))
    } else {
        return _transformSegment(str);
    }
}

/**
 * @param {string[]} matches
 * @returns {RegExp}
 */
function compilePattern(matches) {
    const separators = Array(matches.length).fill('/')
        // Remove separators that come after a '**' segment
        .map((s, i) => matches[i] === '**' ? '' : '/');
    const prepared = matches.map((a, i) =>
        STRING_TESTS.REGEXP.test(a) ?
            // Embedded RegExp, we leave it alone for now
            a.substring(1, Math.max(a.length - 1, 1)) :
            preparePatternStringSegment(a));

    let regexpSegments = dropLast(interleave(prepared, separators), 1);
    // Remove trailing separator since it would be duplicated by the following
    //  process.
    if (regexpSegments.length > 1 && last(regexpSegments) === '/') {
        regexpSegments = init(regexpSegments);
    }
    return new RegExp(`^${regexpSegments.join('')}$`);
}

/**
 * @typedef {Object} PathRule - Match information
 * @property {string[]} match - Array of segments leading up to matched path.
 * @property {RegExp} test - RegExp test that returns true when applied
 *  to matched path.
 * @property {string|function|null} dest - Value corresponding to matched path.
 */

/**
 * Separate compound globstar-expression patterns in given array
 * @param {string[]} segments
 * @example
 * isolateGlobstarPattern(['foo', '**.css', 'bar'])
 * => ['foo', '**', '*.css', 'bar]
 */
function isolateGlobstarPattern(segments) {
    return flatten(segments.map(m => {
            if (!/^(\*\*)(.+)/.test(m)) {
                return m;
            } else {
                const ma = m.match(/^(\*\*)(.+)/);
                return [ ma[1], `*${ma[2]}` ];
            }
        }
    ));
}

function appendGlobstarIfTrailingSlash(segments) {
    const end = last(segments);
    if (!/.\/$/.test(end) || STRING_TESTS.REGEXP.test(end)) {
        return segments;
    }
    return [ ...init(segments), removeTrailing(end, '/'), '**' ];
}

/**
 * Normalize match path: Merge consecutive '**' segments and append a '*' to
 *   trailing '**' segment to match any file in folder)
 */
function preprocessMatchPath(segments) {
    const merged = mergeConsecutive(segments, '**');
    if (merged.length !== segments.length) {
        warn(`Consecutive '**' globs found
              (${segments.length - merged.length} excess).`);
    }
    segments = isolateGlobstarPattern(segments);
    segments = appendGlobstarIfTrailingSlash(segments);
    return mergeConsecutive([ ...segments,
                              ...(last(segments) === '**' ? ['*'] : []) ],
                            '**');
}

/**
 * @returns {PathRule[]}
 */
export default function compilePathMatchingTree(tree) {
    if (!tree || typeof tree !== 'object') {
        throw new TypeError(`compilePathMatchingTree: Invalid "tree"` +
                            ` given ([${typeof tree}]${tree}).`);
    }
    const matchingPaths = AdHocTree.getSlices(tree)
        .map(({ path, leaf }) => {
            const match = preprocessMatchPath(path);
            return { match, test: compilePattern(match), dest: leaf }
        });
    checkTree(matchingPaths);
    return matchingPaths;
}

/**
 * Doesn't modify passed argument
 */
function checkTree(mp) {
    const paths = mp.map(rule => rule.match);
    paths.forEach(path => checkPath(path));
    if (paths.length <= 1) { // Only one rule, no need to check for shadowing
        return true;
    }
    paths.reduce((a, b) => {
        const [ diffA, diffB ] = keepDifference(a, b);
        if (diffA[0] === '**' && diffA[1] === '*' &&
            !(diffB.length === 1 && diffB[0] === '/')) {
            warn(`Inaccessible paths: "${a.join('/')}" shadows following ` +
                 `paths (will never match). Place more specifics rules on top.`);
        }
        return b;
    });
}

/**
 * Doesn't modify passed argument
 */
function checkPath(path) {
    const integerKeySegments =
        path.filter(segment => (/^(0|[1-9][0-9]*)$/.test(segment)));
    if (integerKeySegments.length) {
        warn(`Integer keys will come first in object iteration even if ` +
             `other keys are defined before. Wrap key with '/' to avoid ` +
             `this behavior (${
                integerKeySegments
                    .map(segment => `"${segment}" => "/${segment}/"`).join(', ')
              }).`);
    }
}
