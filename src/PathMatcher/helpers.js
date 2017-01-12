import upath from 'upath';

export const warn = (...args) => console.warn('[path-matching] WARNING:', ...args);

/**
 * Result of path.parse plus `full` property and `toString` method.
 * @property {string} full - Original path given in constructor
 * @method {string} toString - Returns full
 */
export class ParsedPath {
    constructor(pth) {
        Object.assign(this, upath.parse(pth));
        this.full = pth;
    }
    toString() { return this.full; }
}
export const parsePath = pth => new ParsedPath(pth);
