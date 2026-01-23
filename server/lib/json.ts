import assert from "node:assert";

export interface Position {
    indexCu: number;
    line: number;
    column: number;
}

export interface Token {
    ch: string;       // grapheme string
    startCu: number;  // start UTF-16 code-unit index
    endCu: number;    // end UTF-16 code-unit index
    line: number;     // 1-based
    col: number;      // 1-based (graphemes)
}

export class GraphemeScanner {
    private segments: Array<{ segment: string; index: number }> = [];
    private segPos = 0;
    private buffered: Token | null = null;

    // Position of the next unread token
    private cu = 0;
    private line = 1;
    private col = 1;

    // Grapheme segmenter (locale-neutral)
    private readonly segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    public static get EOF() { return "<eof>"; }

    constructor(private readonly str: string) {
        // Materialize segments so we have a stable index for CU boundaries.
        // Performance is fine per your constraints.
        for (const seg of this.segmenter.segment(str)) {
            this.segments.push({ segment: seg.segment, index: seg.index });
        }
    }

    private static posFromToken(t: Token) {
        return { line: t.line, column: t.col, indexCu: t.startCu };
    }

    isEOF(ch: string): boolean {
        return ch === GraphemeScanner.EOF;
    }

    isNL(ch: string): boolean {
        return ch === "\n" || ch === "\r" || ch === "\r\n";
    }

    isWS(ch: string): boolean {
        return ch === " " || ch === "\t" || this.isNL(ch);
    }

    pos(t?: Token): Position {
        return GraphemeScanner.posFromToken(t ?? this.peek());
    }

    eof(t?: Token): boolean {
        return this.isEOF((t ?? this.peek()).ch);
    }

    nl(t?: Token): boolean {
        return this.isNL((t ?? this.peek()).ch);
    }

    ws(t?: Token): boolean {
        return this.isWS((t ?? this.peek()).ch);
    }

    peek(): Token {
        if (this.buffered) return this.buffered;
        if (this.segPos >= this.segments.length) {
            return {
                ch: GraphemeScanner.EOF,
                startCu: this.cu,
                endCu: this.cu,
                line: this.line,
                col: this.col,
            };
        }

        const { segment, index: startCu } = this.segments[this.segPos];
        const endCu =
            this.segPos + 1 < this.segments.length
                ? this.segments[this.segPos + 1].index
                : this.str.length;

        const token: Token = {
            ch: segment,
            startCu,
            endCu,
            line: this.line,
            col: this.col,
        };

        this.buffered = token;
        return token;
    }

    /**
     * Consume the next grapheme token and advance (line, col):
     * - '\n', '\r', or '\r\n' => newline
     * - Any other grapheme advances column by 1
     */
    next(): Token {
        const t = this.peek();
        if (t.ch === GraphemeScanner.EOF) return t;

        this.buffered = null;
        this.segPos++;
        this.cu = t.endCu;

        if (t.ch === "\n" || t.ch === "\r" || t.ch === "\r\n") {
            this.line++;
            this.col = 1;
            return t;
        }

        this.col++;
        return t;
    }
}

export interface RepairResult {
    json: string; // valid JSON text
    value: object; // parsed object
}

export class JsonRepairError extends Error {
    /** 0-based UTF-16 code-unit index */
    public readonly indexCu: number;
    /** 1-based line number */
    public readonly line: number;
    /** 1-based column number (in graphemes) */
    public readonly column: number;

    constructor(message: string, pos: Position) {
        super(`${ message } (line ${ pos.line }, col ${ pos.column })`);
        this.name = "JsonRepairError";
        this.line = pos.line;
        this.column = pos.column;
        this.indexCu = pos.indexCu;
    }
}

/**
 * Repairs a "JSON-like" object string into valid JSON.
 *
 * - Object only: parses a single object; outer braces are optional (whitespace allowed).
 *   Empty/whitespace-only input yields `{}`.
 * - Keys/values: always strings.
 * - Quoted: accept any valid JSON string escaping; normalize via JSON.parse/stringify.
 * - Unquoted: read until delimiter (key ':'; value ',' or '}' or newline; EOF if no braces),
 *   allowing quotes inside; JSON.stringify handles quoting/escaping.
 * - Whitespace: allowed around tokens; unquoted tokens preserve internal whitespace but trim
 *   leading and trailing whitespaces. Newlines accepted as \n, \r, or \r\n; an unquoted
 *   value may terminate on a newline (treated like a comma separator).
 *
 * Error positions are reported in grapheme clusters (Intl.Segmenter).
 */
export function repairInvalidJsonObject(input: string): RepairResult {
    const s = input;
    const cur = new GraphemeScanner(s);

    function err(msg: string, posOverride?: Position): never {
        throw new JsonRepairError(msg, posOverride ?? cur.pos());
    }

    function skipWS(){
        while (true) {
            if (cur.eof() || !cur.ws()) break;
            cur.next();
        }
    }

    function expectChar(expected: string) {
        const t = cur.next();
        if (cur.eof(t)) err(`Expected '${ expected }' but reached end of input`, cur.pos(t));
        if (t.ch !== expected) err(`Expected '${ expected }' but found '${ t.ch }'`, cur.pos(t));
    }

    /**
     * Parse a JSON string token starting at `"`.
     * Quoted strings accept any valid JSON escapes. We scan until the closing quote
     * while ensuring unescaped control characters don't appear.
     * Then JSON.parse validates the escaping.
     */
    function parseQuotedJsonContent(delimiters: Set<string>, what: "key" | "value"): string {
        const first = cur.peek();
        assert(first.ch === '"', "Quoted JSON string does not start with quote");

        const startCu = first.startCu;
        const startPos = cur.pos();

        expectChar('"');

        let escaped = false;

        while (true) {
            const t = cur.next();
            if (cur.eof(t)) err("Unterminated JSON string", startPos);

            if (!escaped) {
                if (t.ch === '"') break;
                if (t.ch === "\\") {
                    escaped = true;
                    continue;
                }
                // JSON forbids unescaped control chars (includes raw \n and \r)
                // Here, control chars are necessarily single-code-unit graphemes.
                if (cur.nl(t)) {
                    err("Unescaped newline character inside JSON string", cur.pos(t));
                } else if (t.ch.length === 1 && t.ch.charCodeAt(0) < 0x20) {
                    err("Unescaped control character inside JSON string", cur.pos(t));
                }
            } else {
                escaped = false;
            }
        }

        const endCu = cur.pos().indexCu; // after closing quote
        const token = s.slice(startCu, endCu);

        let parsed: string;
        try {
            parsed = JSON.parse(token) as string;
        } catch {
            err("Invalid JSON string escaping", startPos);
        }

        // After closing the quote, allow whitespace until a delimiter
        while (true) {
            const p = cur.peek();
            if (delimiters.has(p.ch)) {
                break;
            } else if (cur.eof(p)) {
                err(`Reached end of input while parsing ${ what }`, startPos);
            } else if (!cur.ws(p)) {
                err(`Expected ${ Array.from(delimiters.values().filter((value) => !cur.isWS(value)))
                    .join(" or ") } after ${ what } but found '${ p.ch }'`, cur.pos(p));
            }
            cur.next();
        }

        // Return the parsed string value (no surrounding quotes); caller uses JSON.stringify.
        return parsed;
    }

    /**
     * Parse an unquoted token until a delimiter.
     */
    function parseUnquotedUntil(
        delimiters: Set<string>,
        what: "key" | "value"
    ): string {
        if (cur.eof()) err(`Reached end of input while parsing ${ what }`);
        if (cur.ws()) err(`Empty unquoted ${ what }`);

        const startPos = cur.pos();
        const startCu = startPos.indexCu;

        let lastNonWsEndCu = -1;

        while (true) {
            const p = cur.peek();
            if (delimiters.has(p.ch)) break;
            if (cur.eof(p)) err(`Reached end of input while parsing ${ what }`, startPos);

            if (cur.ws(p)) {
                const wsPos = cur.pos();

                // consume whitespaces
                while (true) {
                    const w = cur.peek();
                    if (delimiters.has(w.ch)) {
                        break;
                    } else if (cur.eof(w)) {
                        err(`Reached end of input while parsing ${ what }`, startPos);
                    } else if (cur.nl(w)) {
                        err(`Expected ${ Array.from(delimiters.values().filter((value) => !cur.isWS(value)))
                            .join(" or ") } after ${ what }, but found a newline`, wsPos);
                    } else if (!cur.ws(w)) {
                        break;
                    }
                    cur.next();
                }

                const after = cur.peek();
                if (delimiters.has(after.ch)) {
                    break;
                }
            }

            lastNonWsEndCu = (cur.next()).endCu;
        }

        if (lastNonWsEndCu < 0) err(`Empty unquoted ${ what }`, startPos);

        const raw = s.slice(startCu, lastNonWsEndCu);
        const delim = cur.peek();
        if (!delim || !delimiters.has(delim.ch)) err(`Reached end of input while parsing ${ what }`, startPos);
        return raw;
    }

    function checkFinishNoBraces(what: "key" | "value" | "end") {
        if (cur.eof()) {
            if (what === "key" || what === "end") {
                return true;
            } else {
                err("Reached end of input while expecting a value");
            }
        } else {
            return false;
        }
    }

    function checkFinishWithBraces(what: "key" | "value" | "end", t?: Token) {
        if (cur.eof(t)) {
            if (what === "end") {
                err(`Reached end of input while expecting a closing brace '}'`);
            } else {
                err(`Reached end of input while expecting a ${ what }`);
            }
        } else if ((t ?? cur.peek()).ch === "}") {
            if (what === "key" || what === "end") {
                return true;
            } else {
                err("Unexpected '}' instead of a value");
            }
        } else {
            return false;
        }
    }

    // ---- Parse object ----
    skipWS();

    const ps = cur.peek();
    const insideBraces = ps?.ch === "{";
    const checkFinish = insideBraces ? checkFinishWithBraces : checkFinishNoBraces;
    if (insideBraces) {
        // Consume initial token
        cur.next();
    }

    const keyDelimiters = new Set([":"]);
    const valueConditionalDelimiters = insideBraces ? ["}"] : [GraphemeScanner.EOF];
    const valueDelimiters = new Set([",", ...valueConditionalDelimiters]);
    const valueDelimitersWithNL = new Set([...valueDelimiters, "\n", "\r", "\r\n"]);

    const obj: Record<string, string> = {};
    const parts: string[] = [];

    while (true) {
        skipWS();

        // key
        if (checkFinish("key")) {
            // Consume finishing token
            cur.next();
            break;
        }
        const pk = cur.peek()!;
        if (pk.ch === ",") {
            cur.next();
            continue;
        }
        const keyContent =
            pk.ch === '"' ? parseQuotedJsonContent(keyDelimiters, "key") : parseUnquotedUntil(keyDelimiters, "key");

        expectChar(":");
        skipWS();

        // value
        if (checkFinish("value")) break;
        const pv = cur.peek();
        const valContent =
            pv.ch === '"' ? parseQuotedJsonContent(valueDelimiters, "value") : parseUnquotedUntil(valueDelimitersWithNL, "value");

        // decode for a returned object
        obj[keyContent] = valContent;
        parts.push(`${ JSON.stringify(keyContent) }:${ JSON.stringify(valContent) }`);

        if (checkFinish("end", cur.next())) break;
    }

    skipWS();
    if (!cur.eof()) err("Unexpected trailing characters after '}'");

    const json = `{${ parts.join(",") }}`;
    return { json, value: obj };
}

export function makeValidJsonObjectText(input: string): string {
    return repairInvalidJsonObject(input).json;
}

export function parseInvalidJsonObject(input: string): object {
    return repairInvalidJsonObject(input).value;
}
