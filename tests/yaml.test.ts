/**
 * Tests for src/yaml.ts — PyYAML safe_load / safe_dump parity.
 *
 * Expected values were generated with PyYAML 6.0.3 (`yaml.safe_load`,
 * `yaml.safe_dump`). When SPEC_KIT_UPSTREAM points at a clone of upstream
 * spec-kit, every upstream *.yml / frontmatter is also checked.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  YAMLError,
  ComposerError,
  ConstructorError,
  ParserError,
  ScannerError,
  dumpYaml,
  isEmptyYamlDocument,
  parseYaml,
  yamlHasNode,
} from '../src/yaml.js';

// ============================================================================
// Fixtures generated from PyYAML
// ============================================================================

const PARSE_CASES: Array<[string, unknown, string?]> = [["a:\tb", null, "while scanning for the next token\nfound character '\\t' that cannot start any token\n  in \"<unicode string>\", line 1, column 3:\n    a:\tb\n      ^"], ["a: x\ty", null, "while scanning for the next token\nfound character '\\t' that cannot start any token\n  in \"<unicode string>\", line 1, column 5:\n    a: x\ty\n        ^"], ["\ta: 1", null, "while scanning for the next token\nfound character '\\t' that cannot start any token\n  in \"<unicode string>\", line 1, column 1:\n    \ta: 1\n    ^"], ["|\nfoo", null, "expected '<document start>', but found '<scalar>'\n  in \"<unicode string>\", line 2, column 1:\n    foo\n    ^"], ["a: foo\n  bar: baz", null, "mapping values are not allowed here\n  in \"<unicode string>\", line 2, column 6:\n      bar: baz\n         ^"], ["--- a: 1", null, "mapping values are not allowed here\n  in \"<unicode string>\", line 1, column 6:\n    --- a: 1\n         ^"], ["a: 1\n---\n", null, "expected a single document in the stream\n  in \"<unicode string>\", line 1, column 1:\n    a: 1\n    ^\nbut found another document\n  in \"<unicode string>\", line 2, column 1:\n    ---\n    ^"], ["a: =", null, "could not determine a constructor for the tag 'tag:yaml.org,2002:value'\n  in \"<unicode string>\", line 1, column 4:\n    a: =\n       ^"], ["- - a\n  - b", [["a", "b"]]], ["a: - b", null, "sequence entries are not allowed here\n  in \"<unicode string>\", line 1, column 4:\n    a: - b\n       ^"], ["a: b: c", null, "mapping values are not allowed here\n  in \"<unicode string>\", line 1, column 5:\n    a: b: c\n        ^"], ["k: 1e3", {"k": "1e3"}], ["k: 1.0e3", {"k": "1.0e3"}], ["k: 1.0e+3", {"k": 1000.0}], ["k: 0755", {"k": 493}], ["k: 0o17", {"k": "0o17"}], ["k: 190:20:30", {"k": 685230}], ["k: 2024-01-01", {"k": "2024-01-01"}], ["k: [a, b: c, {d: e}]", {"k": ["a", {"b": "c"}, {"d": "e"}]}], ["? a\n: b", {"a": "b"}], ["a: 'x\n\n  y'", {"a": "x\ny"}], ["a: \"x\\\n  y\"", {"a": "xy"}], ["&a b: 1\nc: *a", {"b": 1, "c": "b"}], ["'a': [1,]", {"a": [1]}], ["", null], ["# only comment\n", null], ["---\n", null], ["--- \n...\n", null], ["null", null], ["~", null], ["[]", []], ["{}", {}], ["a: |\n  line1\n  line2\n\n  line4\n\n\nb: 1", {"a": "line1\nline2\n\nline4\n", "b": 1}], ["a: >\n  folded\n  text\n\n  para\n    more\n  end\n", {"a": "folded text\npara\n  more\nend\n"}], ["a: |-\n  x\n\n", {"a": "x"}], ["a: |+\n  x\n\n", {"a": "x\n\n"}], ["a: |2\n    indented\n  x\n", {"a": "  indented\nx\n"}], ["- a\n- b:\n    c: d\n  e: f\n-\n- - x", ["a", {"b": {"c": "d"}, "e": "f"}, null, ["x"]]], ["a:\n- 1\n- 2\nb:\n  - 3", {"a": [1, 2], "b": [3]}], ["base: &b {x: 1, y: 2}\nderived:\n  <<: *b\n  y: 3", {"base": {"x": 1, "y": 2}, "derived": {"x": 1, "y": 3}}], ["m:\n  <<: [{a: 1}, {a: 2, b: 2}]\n  c: 3", {"m": {"a": 1, "b": 2, "c": 3}}], ["s: 'it''s'", {"s": "it's"}], ["d: \"tab\\there \\u00e9 \\x41 \\U0001F600\"", {"d": "tab\there \u00e9 A \ud83d\ude00"}], ["plain: this is\n  multi line\n\n  text", {"plain": "this is multi line\ntext"}], ["t: yes\nf: Off\nn: NULL\ni: -0x1F\nb: 0b101\nf2: .5\nf3: -.inf\nnan: .NaN\nf4: 1_000.5\ni2: 1_000", {"b": 5, "f": false, "f2": 0.5, "f3": "-inf", "f4": 1000.5, "i": -31, "i2": 1000, "n": null, "nan": "nan", "t": true}], ["key with spaces: v\n\"quoted key\": v2\n'sq': v3", {"key with spaces": "v", "quoted key": "v2", "sq": "v3"}], ["url: http://example.com:8080/path#frag", {"url": "http://example.com:8080/path#frag"}], ["a: b # comment\nc: 'd' # c2", {"a": "b", "c": "d"}], ["- !!str 123\n- !!int '7'\n- !!float 1\n- ! 12\n- !!null ''", ["123", 7, 1.0, 12, null]], ["a: !custom x", null, "could not determine a constructor for the tag '!custom'\n  in \"<unicode string>\", line 1, column 4:\n    a: !custom x\n       ^"], ["a: *undef", null, "found undefined alias 'undef'\n  in \"<unicode string>\", line 1, column 4:\n    a: *undef\n       ^"], ["a: &x 1\nb: &x 2", null, "found duplicate anchor 'x'; first occurrence\n  in \"<unicode string>\", line 1, column 4:\n    a: &x 1\n       ^\nsecond occurrence\n  in \"<unicode string>\", line 2, column 4:\n    b: &x 2\n       ^"], ["a: [1, 2", null, "while parsing a flow sequence\n  in \"<unicode string>\", line 1, column 4:\n    a: [1, 2\n       ^\nexpected ',' or ']', but got '<stream end>'\n  in \"<unicode string>\", line 1, column 9:\n    a: [1, 2\n            ^"], ["a: 'unterminated", null, "while scanning a quoted scalar\n  in \"<unicode string>\", line 1, column 4:\n    a: 'unterminated\n       ^\nfound unexpected end of stream\n  in \"<unicode string>\", line 1, column 17:\n    a: 'unterminated\n                    ^"], ["a: \"bad \\q escape\"", null, "while scanning a double-quoted scalar\n  in \"<unicode string>\", line 1, column 4:\n    a: \"bad \\q escape\"\n       ^\nfound unknown escape character 'q'\n  in \"<unicode string>\", line 1, column 10:\n    a: \"bad \\q escape\"\n             ^"], ["{a: 1, b}", {"a": 1, "b": null}], ["- [a, [b, c], {d: [e]}]", [["a", ["b", "c"], {"d": ["e"]}]]], ["a:\n  b:\n    c: 1\n  d: 2\ne: 3", {"a": {"b": {"c": 1}, "d": 2}, "e": 3}], ["a: 1\n b: 2", null, "mapping values are not allowed here\n  in \"<unicode string>\", line 2, column 3:\n     b: 2\n      ^"], ["a:\n  - b\n  c: d", null, "while parsing a block collection\n  in \"<unicode string>\", line 2, column 3:\n      - b\n      ^\nexpected <block end>, but found '?'\n  in \"<unicode string>\", line 3, column 3:\n      c: d\n      ^"], ["k: v\n...\n", {"k": "v"}], ["%YAML 1.1\n---\na: 1", {"a": 1}], ["a: @x", null, "while scanning for the next token\nfound character '@' that cannot start any token\n  in \"<unicode string>\", line 1, column 4:\n    a: @x\n       ^"], ["a: `x", null, "while scanning for the next token\nfound character '`' that cannot start any token\n  in \"<unicode string>\", line 1, column 4:\n    a: `x\n       ^"], ["? [a]\n: b", null, "while constructing a mapping\n  in \"<unicode string>\", line 1, column 1:\n    ? [a]\n    ^\nfound unhashable key\n  in \"<unicode string>\", line 1, column 3:\n    ? [a]\n      ^"], ["list:\n- name: x\n  desc: >-\n    hello\n    world\n- name: y", {"list": [{"desc": "hello world", "name": "x"}, {"name": "y"}]}], ["a: 'multi\n  line single'", {"a": "multi line single"}], ["a: \"multi\n  line\n\n  double\"", {"a": "multi line\ndouble"}], ["- ---x\n- ...", ["---x", "..."]], ["a: -1\nb: +1\nc: 00\nd: 09", {"a": -1, "b": 1, "c": 0, "d": "09"}], ["a: 0.1\nb: 1.\nc: 1.5e-3", {"a": 0.1, "b": 1.0, "c": 0.0015}], ["a: [a: 1, b]", {"a": [{"a": 1}, "b"]}], ["a: {? b}", {"a": {"b": null}}], ["x: - y", null, "sequence entries are not allowed here\n  in \"<unicode string>\", line 1, column 4:\n    x: - y\n       ^"], ["- a\nb: c", null, "while parsing a block collection\n  in \"<unicode string>\", line 1, column 1:\n    - a\n    ^\nexpected <block end>, but found '?'\n  in \"<unicode string>\", line 2, column 1:\n    b: c\n    ^"], ["a: 1\n- b", null, "while parsing a block mapping\n  in \"<unicode string>\", line 1, column 1:\n    a: 1\n    ^\nexpected <block end>, but found '-'\n  in \"<unicode string>\", line 2, column 1:\n    - b\n    ^"], ["emoji: \ud83d\ude00 ok", {"emoji": "\ud83d\ude00 ok"}], ["k: \"\\/\"", {"k": "/"}], ["long: word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ", {"long": "word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word"}]];
const DUMP_CASES: Array<[unknown, Record<string, string>]> = [["abc", {"d0": "abc\n...\n", "d1": "abc\n...\n", "d2": "abc\n...\n", "d3": "abc\n...\n", "d4": "abc\n...\n", "d5": "abc\n...\n", "d6": "\"abc\"\n", "d7": "--- abc\n...\n"}], ["a b", {"d0": "a b\n...\n", "d1": "a b\n...\n", "d2": "a b\n...\n", "d3": "a b\n...\n", "d4": "a b\n...\n", "d5": "a b\n...\n", "d6": "\"a b\"\n", "d7": "--- a b\n...\n"}], ["true", {"d0": "'true'\n", "d1": "'true'\n", "d2": "'true'\n", "d3": "'true'\n", "d4": "'true'\n", "d5": "'true'\n", "d6": "\"true\"\n", "d7": "--- 'true'\n"}], ["", {"d0": "''\n", "d1": "''\n", "d2": "''\n", "d3": "''\n", "d4": "''\n", "d5": "''\n", "d6": "\"\"\n", "d7": "--- ''\n"}], ["x\ny", {"d0": "'x\n\n  y'\n", "d1": "'x\n\n  y'\n", "d2": "'x\n\n  y'\n", "d3": "'x\n\n  y'\n", "d4": "'x\n\n    y'\n", "d5": "'x\n\n  y'\n", "d6": "\"x\\ny\"\n", "d7": "--- 'x\n\n  y'\n"}], ["\u00e9", {"d0": "\"\\xE9\"\n", "d1": "\u00e9\n...\n", "d2": "\"\\xE9\"\n", "d3": "\"\\xE9\"\n", "d4": "\"\\xE9\"\n", "d5": "\"\\xE9\"\n", "d6": "\"\u00e9\"\n", "d7": "--- \"\\xE9\"\n"}], ["tab\there", {"d0": "\"tab\\there\"\n", "d1": "\"tab\\there\"\n", "d2": "\"tab\\there\"\n", "d3": "\"tab\\there\"\n", "d4": "\"tab\\there\"\n", "d5": "\"tab\\there\"\n", "d6": "\"tab\\there\"\n", "d7": "--- \"tab\\there\"\n"}], ["1", {"d0": "'1'\n", "d1": "'1'\n", "d2": "'1'\n", "d3": "'1'\n", "d4": "'1'\n", "d5": "'1'\n", "d6": "\"1\"\n", "d7": "--- '1'\n"}], [1.5, {"d0": "1.5\n...\n", "d1": "1.5\n...\n", "d2": "1.5\n...\n", "d3": "1.5\n...\n", "d4": "1.5\n...\n", "d5": "1.5\n...\n", "d6": "!!float \"1.5\"\n", "d7": "--- 1.5\n...\n"}], [1e-05, {"d0": "1.0e-05\n...\n", "d1": "1.0e-05\n...\n", "d2": "1.0e-05\n...\n", "d3": "1.0e-05\n...\n", "d4": "1.0e-05\n...\n", "d5": "1.0e-05\n...\n", "d6": "!!float \"1.0e-05\"\n", "d7": "--- 1.0e-05\n...\n"}], [0.1, {"d0": "0.1\n...\n", "d1": "0.1\n...\n", "d2": "0.1\n...\n", "d3": "0.1\n...\n", "d4": "0.1\n...\n", "d5": "0.1\n...\n", "d6": "!!float \"0.1\"\n", "d7": "--- 0.1\n...\n"}], [123456789.123, {"d0": "123456789.123\n...\n", "d1": "123456789.123\n...\n", "d2": "123456789.123\n...\n", "d3": "123456789.123\n...\n", "d4": "123456789.123\n...\n", "d5": "123456789.123\n...\n", "d6": "!!float \"123456789.123\"\n", "d7": "--- 123456789.123\n...\n"}], [1e-07, {"d0": "1.0e-07\n...\n", "d1": "1.0e-07\n...\n", "d2": "1.0e-07\n...\n", "d3": "1.0e-07\n...\n", "d4": "1.0e-07\n...\n", "d5": "1.0e-07\n...\n", "d6": "!!float \"1.0e-07\"\n", "d7": "--- 1.0e-07\n...\n"}], [null, {"d0": "null\n...\n", "d1": "null\n...\n", "d2": "null\n...\n", "d3": "null\n...\n", "d4": "null\n...\n", "d5": "null\n...\n", "d6": "!!null \"null\"\n", "d7": "--- null\n...\n"}], [[], {"d0": "[]\n", "d1": "[]\n", "d2": "[]\n", "d3": "[]\n", "d4": "[]\n", "d5": "[]\n", "d6": "[]\n", "d7": "--- []\n"}], [{}, {"d0": "{}\n", "d1": "{}\n", "d2": "{}\n", "d3": "{}\n", "d4": "{}\n", "d5": "{}\n", "d6": "{}\n", "d7": "--- {}\n"}], [{"a": [1, {"b": null}], "c": {}}, {"d0": "a:\n- 1\n- b: null\nc: {}\n", "d1": "a:\n- 1\n- b: null\nc: {}\n", "d2": "a:\n- 1\n- {b: null}\nc: {}\n", "d3": "{a: [1, {b: null}], c: {}}\n", "d4": "a:\n- 1\n-   b: null\nc: {}\n", "d5": "a:\n- 1\n- b: null\nc: {}\n", "d6": "\"a\":\n- !!int \"1\"\n- \"b\": !!null \"null\"\n\"c\": {}\n", "d7": "---\na:\n- 1\n- b: null\nc: {}\n"}], ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z ", {"d0": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l\n  m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n", "d1": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l\n  m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n", "d2": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l\n  m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n", "d3": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l\n  m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n", "d4": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k\n    l m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n", "d5": "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q\n  r s t u v w x y z  c d e f g h i j k l m\n  n o p q r s t u v w x y z  c d e f g h i\n  j k l m n o p q r s t u v w x y z '\n", "d6": "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z \"\n", "d7": "--- 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  bbbbbbbbbb c d e f g h i j k l m n o p q r s t u v w x y z  c d e f g h i j k l\n  m n o p q r s t u v w x y z  c d e f g h i j k l m n o p q r s t u v w x y z '\n"}], ["- x", {"d0": "'- x'\n", "d1": "'- x'\n", "d2": "'- x'\n", "d3": "'- x'\n", "d4": "'- x'\n", "d5": "'- x'\n", "d6": "\"- x\"\n", "d7": "--- '- x'\n"}], ["x: y", {"d0": "'x: y'\n", "d1": "'x: y'\n", "d2": "'x: y'\n", "d3": "'x: y'\n", "d4": "'x: y'\n", "d5": "'x: y'\n", "d6": "\"x: y\"\n", "d7": "--- 'x: y'\n"}], ["#x", {"d0": "'#x'\n", "d1": "'#x'\n", "d2": "'#x'\n", "d3": "'#x'\n", "d4": "'#x'\n", "d5": "'#x'\n", "d6": "\"#x\"\n", "d7": "--- '#x'\n"}], ["x #y", {"d0": "'x #y'\n", "d1": "'x #y'\n", "d2": "'x #y'\n", "d3": "'x #y'\n", "d4": "'x #y'\n", "d5": "'x #y'\n", "d6": "\"x #y\"\n", "d7": "--- 'x #y'\n"}], ["@x", {"d0": "'@x'\n", "d1": "'@x'\n", "d2": "'@x'\n", "d3": "'@x'\n", "d4": "'@x'\n", "d5": "'@x'\n", "d6": "\"@x\"\n", "d7": "--- '@x'\n"}], ["a'b", {"d0": "a'b\n...\n", "d1": "a'b\n...\n", "d2": "a'b\n...\n", "d3": "a'b\n...\n", "d4": "a'b\n...\n", "d5": "a'b\n...\n", "d6": "\"a'b\"\n", "d7": "--- a'b\n...\n"}], ["'a", {"d0": "'''a'\n", "d1": "'''a'\n", "d2": "'''a'\n", "d3": "'''a'\n", "d4": "'''a'\n", "d5": "'''a'\n", "d6": "\"'a\"\n", "d7": "--- '''a'\n"}], [{"k": "line1\nline2\n", "e": "\u00e9\ud83d\ude00"}, {"d0": "e: \"\\xE9\\U0001F600\"\nk: 'line1\n\n  line2\n\n  '\n", "d1": "k: 'line1\n\n  line2\n\n  '\ne: \u00e9\ud83d\ude00\n", "d2": "{e: \"\\xE9\\U0001F600\", k: 'line1\n\n    line2\n\n    '}\n", "d3": "{e: \"\\xE9\\U0001F600\", k: 'line1\n\n    line2\n\n    '}\n", "d4": "e: \"\\xE9\\U0001F600\"\nk: 'line1\n\n    line2\n\n    '\n", "d5": "e: \"\\xE9\\U0001F600\"\nk: 'line1\n\n  line2\n\n  '\n", "d6": "\"e\": \"\u00e9\\U0001F600\"\n\"k\": \"line1\\nline2\\n\"\n", "d7": "---\ne: \"\\xE9\\U0001F600\"\nk: 'line1\n\n  line2\n\n  '\n"}], [{"z": 1, "a": 2, "M": 3, "_": 4}, {"d0": "M: 3\n_: 4\na: 2\nz: 1\n", "d1": "z: 1\na: 2\nM: 3\n_: 4\n", "d2": "{M: 3, _: 4, a: 2, z: 1}\n", "d3": "{M: 3, _: 4, a: 2, z: 1}\n", "d4": "M: 3\n_: 4\na: 2\nz: 1\n", "d5": "M: 3\n_: 4\na: 2\nz: 1\n", "d6": "\"M\": !!int \"3\"\n\"_\": !!int \"4\"\n\"a\": !!int \"2\"\n\"z\": !!int \"1\"\n", "d7": "---\nM: 3\n_: 4\na: 2\nz: 1\n"}], [[[1, 2], [{"a": 1}], [], [[]]], {"d0": "- - 1\n  - 2\n- - a: 1\n- []\n- - []\n", "d1": "- - 1\n  - 2\n- - a: 1\n- []\n- - []\n", "d2": "- [1, 2]\n- - {a: 1}\n- []\n- - []\n", "d3": "[[1, 2], [{a: 1}], [], [[]]]\n", "d4": "-   - 1\n    - 2\n-   -   a: 1\n- []\n-   - []\n", "d5": "- - 1\n  - 2\n- - a: 1\n- []\n- - []\n", "d6": "- - !!int \"1\"\n  - !!int \"2\"\n- - \"a\": !!int \"1\"\n- []\n- - []\n", "d7": "---\n- - 1\n  - 2\n- - a: 1\n- []\n- - []\n"}], [{"a": {"b": {"c": [1, {"d": "e"}]}}}, {"d0": "a:\n  b:\n    c:\n    - 1\n    - d: e\n", "d1": "a:\n  b:\n    c:\n    - 1\n    - d: e\n", "d2": "a:\n  b:\n    c:\n    - 1\n    - {d: e}\n", "d3": "{a: {b: {c: [1, {d: e}]}}}\n", "d4": "a:\n    b:\n        c:\n        - 1\n        -   d: e\n", "d5": "a:\n  b:\n    c:\n    - 1\n    - d: e\n", "d6": "\"a\":\n  \"b\":\n    \"c\":\n    - !!int \"1\"\n    - \"d\": \"e\"\n", "d7": "---\na:\n  b:\n    c:\n    - 1\n    - d: e\n"}], [{"desc": "Run the command: do it now", "x": "null", "y": "yes", "z": "~", "w": "123", "v": "1.5", "u": "0x1F", "t": "2024-01-01"}, {"d0": "desc: 'Run the command: do it now'\nt: '2024-01-01'\nu: '0x1F'\nv: '1.5'\nw: '123'\nx: 'null'\ny: 'yes'\nz: '~'\n", "d1": "desc: 'Run the command: do it now'\nx: 'null'\ny: 'yes'\nz: '~'\nw: '123'\nv: '1.5'\nu: '0x1F'\nt: '2024-01-01'\n", "d2": "{desc: 'Run the command: do it now', t: '2024-01-01', u: '0x1F', v: '1.5', w: '123',\n  x: 'null', y: 'yes', z: '~'}\n", "d3": "{desc: 'Run the command: do it now', t: '2024-01-01', u: '0x1F', v: '1.5', w: '123',\n  x: 'null', y: 'yes', z: '~'}\n", "d4": "desc: 'Run the command: do it now'\nt: '2024-01-01'\nu: '0x1F'\nv: '1.5'\nw: '123'\nx: 'null'\ny: 'yes'\nz: '~'\n", "d5": "desc: 'Run the command: do it now'\nt: '2024-01-01'\nu: '0x1F'\nv: '1.5'\nw: '123'\nx: 'null'\ny: 'yes'\nz: '~'\n", "d6": "\"desc\": \"Run the command: do it now\"\n\"t\": \"2024-01-01\"\n\"u\": \"0x1F\"\n\"v\": \"1.5\"\n\"w\": \"123\"\n\"x\": \"null\"\n\"y\": \"yes\"\n\"z\": \"~\"\n", "d7": "---\ndesc: 'Run the command: do it now'\nt: '2024-01-01'\nu: '0x1F'\nv: '1.5'\nw: '123'\nx: 'null'\ny: 'yes'\nz: '~'\n"}], [{"s": " leading", "t": "trailing ", "u": "\nlead", "v": "trail\n", "w": "a\n\nb", "x": "a \nb", "y": "a\n b"}, {"d0": "s: ' leading'\nt: 'trailing '\nu: '\n\n  lead'\nv: 'trail\n\n  '\nw: 'a\n\n\n  b'\nx: \"a \\nb\"\ny: \"a\\n b\"\n", "d1": "s: ' leading'\nt: 'trailing '\nu: '\n\n  lead'\nv: 'trail\n\n  '\nw: 'a\n\n\n  b'\nx: \"a \\nb\"\ny: \"a\\n b\"\n", "d2": "{s: ' leading', t: 'trailing ', u: '\n\n    lead', v: 'trail\n\n    ', w: 'a\n\n\n    b', x: \"a \\nb\", y: \"a\\n b\"}\n", "d3": "{s: ' leading', t: 'trailing ', u: '\n\n    lead', v: 'trail\n\n    ', w: 'a\n\n\n    b', x: \"a \\nb\", y: \"a\\n b\"}\n", "d4": "s: ' leading'\nt: 'trailing '\nu: '\n\n    lead'\nv: 'trail\n\n    '\nw: 'a\n\n\n    b'\nx: \"a \\nb\"\ny: \"a\\n b\"\n", "d5": "s: ' leading'\nt: 'trailing '\nu: '\n\n  lead'\nv: 'trail\n\n  '\nw: 'a\n\n\n  b'\nx: \"a \\nb\"\ny: \"a\\n b\"\n", "d6": "\"s\": \" leading\"\n\"t\": \"trailing \"\n\"u\": \"\\nlead\"\n\"v\": \"trail\\n\"\n\"w\": \"a\\n\\nb\"\n\"x\": \"a \\nb\"\n\"y\": \"a\\n b\"\n", "d7": "---\ns: ' leading'\nt: 'trailing '\nu: '\n\n  lead'\nv: 'trail\n\n  '\nw: 'a\n\n\n  b'\nx: \"a \\nb\"\ny: \"a\\n b\"\n"}], [{"long": "word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ", "longq": "'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' ", "longd": "\u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 "}, {"d0": "long: 'word word word word word word word word word word word word word word word\n  word word word word word word word word word word word word word word word word\n  word word word word word word word word word '\nlongd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \"\nlongq: '''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '\n", "d1": "long: 'word word word word word word word word word word word word word word word\n  word word word word word word word word word word word word word word word word\n  word word word word word word word word word '\nlongq: '''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '\nlongd: '\u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9\n  \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 '\n", "d2": "{long: 'word word word word word word word word word word word word word word word\n    word word word word word word word word word word word word word word word word\n    word word word word word word word word word ', longd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \", longq: '''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '}\n", "d3": "{long: 'word word word word word word word word word word word word word word word\n    word word word word word word word word word word word word word word word word\n    word word word word word word word word word ', longd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \", longq: '''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '}\n", "d4": "long: 'word word word word word word word word word word word word word word word\n    word word word word word word word word word word word word word word word word\n    word word word word word word word word word '\nlongd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n    \\ \\xE9 \\xE9 \\xE9 \"\nlongq: '''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n    ''q'' '\n", "d5": "long: 'word word word word word word word\n  word word word word word word word word\n  word word word word word word word word\n  word word word word word word word word\n  word word word word word word word word\n  word '\nlongd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \"\nlongq: '''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '\n", "d6": "\"long\": \"word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word \"\n\"longd\": \"\u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \u00e9 \"\n\"longq\": \"'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' 'q' \"\n", "d7": "---\nlong: 'word word word word word word word word word word word word word word word\n  word word word word word word word word word word word word word word word word\n  word word word word word word word word word '\nlongd: \"\\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9 \\xE9\\\n  \\ \\xE9 \\xE9 \\xE9 \"\nlongq: '''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q''\n  ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' ''q'' '\n"}], [{"": "empty key", "k": ""}, {"d0": "? ''\n: empty key\nk: ''\n", "d1": "? ''\n: empty key\nk: ''\n", "d2": "{? '' : empty key, k: ''}\n", "d3": "{? '' : empty key, k: ''}\n", "d4": "? ''\n: empty key\nk: ''\n", "d5": "? ''\n: empty key\nk: ''\n", "d6": "? \"\"\n: \"empty key\"\n\"k\": \"\"\n", "d7": "---\n? ''\n: empty key\nk: ''\n"}], [{"key: colon": 1, "- dash": 2, "? q": 3, "[b]": 4}, {"d0": "'- dash': 2\n'? q': 3\n'[b]': 4\n'key: colon': 1\n", "d1": "'key: colon': 1\n'- dash': 2\n'? q': 3\n'[b]': 4\n", "d2": "{'- dash': 2, '? q': 3, '[b]': 4, 'key: colon': 1}\n", "d3": "{'- dash': 2, '? q': 3, '[b]': 4, 'key: colon': 1}\n", "d4": "'- dash': 2\n'? q': 3\n'[b]': 4\n'key: colon': 1\n", "d5": "'- dash': 2\n'? q': 3\n'[b]': 4\n'key: colon': 1\n", "d6": "\"- dash\": !!int \"2\"\n\"? q\": !!int \"3\"\n\"[b]\": !!int \"4\"\n\"key: colon\": !!int \"1\"\n", "d7": "---\n'- dash': 2\n'? q': 3\n'[b]': 4\n'key: colon': 1\n"}], ["---", {"d0": "'---'\n", "d1": "'---'\n", "d2": "'---'\n", "d3": "'---'\n", "d4": "'---'\n", "d5": "'---'\n", "d6": "\"---\"\n", "d7": "--- '---'\n"}], ["...", {"d0": "'...'\n", "d1": "'...'\n", "d2": "'...'\n", "d3": "'...'\n", "d4": "'...'\n", "d5": "'...'\n", "d6": "\"...\"\n", "d7": "--- '...'\n"}], ["- ", {"d0": "'- '\n", "d1": "'- '\n", "d2": "'- '\n", "d3": "'- '\n", "d4": "'- '\n", "d5": "'- '\n", "d6": "\"- \"\n", "d7": "--- '- '\n"}], ["a: b", {"d0": "'a: b'\n", "d1": "'a: b'\n", "d2": "'a: b'\n", "d3": "'a: b'\n", "d4": "'a: b'\n", "d5": "'a: b'\n", "d6": "\"a: b\"\n", "d7": "--- 'a: b'\n"}], ["{x}", {"d0": "'{x}'\n", "d1": "'{x}'\n", "d2": "'{x}'\n", "d3": "'{x}'\n", "d4": "'{x}'\n", "d5": "'{x}'\n", "d6": "\"{x}\"\n", "d7": "--- '{x}'\n"}], ["!tag", {"d0": "'!tag'\n", "d1": "'!tag'\n", "d2": "'!tag'\n", "d3": "'!tag'\n", "d4": "'!tag'\n", "d5": "'!tag'\n", "d6": "\"!tag\"\n", "d7": "--- '!tag'\n"}], ["*x", {"d0": "'*x'\n", "d1": "'*x'\n", "d2": "'*x'\n", "d3": "'*x'\n", "d4": "'*x'\n", "d5": "'*x'\n", "d6": "\"*x\"\n", "d7": "--- '*x'\n"}], ["&y", {"d0": "'&y'\n", "d1": "'&y'\n", "d2": "'&y'\n", "d3": "'&y'\n", "d4": "'&y'\n", "d5": "'&y'\n", "d6": "\"&y\"\n", "d7": "--- '&y'\n"}], ["|", {"d0": "'|'\n", "d1": "'|'\n", "d2": "'|'\n", "d3": "'|'\n", "d4": "'|'\n", "d5": "'|'\n", "d6": "\"|\"\n", "d7": "--- '|'\n"}], [">", {"d0": "'>'\n", "d1": "'>'\n", "d2": "'>'\n", "d3": "'>'\n", "d4": "'>'\n", "d5": "'>'\n", "d6": "\">\"\n", "d7": "--- '>'\n"}], ["%p", {"d0": "'%p'\n", "d1": "'%p'\n", "d2": "'%p'\n", "d3": "'%p'\n", "d4": "'%p'\n", "d5": "'%p'\n", "d6": "\"%p\"\n", "d7": "--- '%p'\n"}], ["`b", {"d0": "'`b'\n", "d1": "'`b'\n", "d2": "'`b'\n", "d3": "'`b'\n", "d4": "'`b'\n", "d5": "'`b'\n", "d6": "\"`b\"\n", "d7": "--- '`b'\n"}], ["\ttab", {"d0": "\"\\ttab\"\n", "d1": "\"\\ttab\"\n", "d2": "\"\\ttab\"\n", "d3": "\"\\ttab\"\n", "d4": "\"\\ttab\"\n", "d5": "\"\\ttab\"\n", "d6": "\"\\ttab\"\n", "d7": "--- \"\\ttab\"\n"}], ["a\u2028b", {"d0": "\"a\\Lb\"\n", "d1": "'a\u2028  b'\n", "d2": "\"a\\Lb\"\n", "d3": "\"a\\Lb\"\n", "d4": "\"a\\Lb\"\n", "d5": "\"a\\Lb\"\n", "d6": "\"a\\Lb\"\n", "d7": "--- \"a\\Lb\"\n"}], ["\u0085", {"d0": "\"\\N\"\n", "d1": "'\u0085  '\n", "d2": "\"\\N\"\n", "d3": "\"\\N\"\n", "d4": "\"\\N\"\n", "d5": "\"\\N\"\n", "d6": "\"\\N\"\n", "d7": "--- \"\\N\"\n"}], ["\ufeffbom", {"d0": "\"\\uFEFFbom\"\n", "d1": "\"\\uFEFFbom\"\n", "d2": "\"\\uFEFFbom\"\n", "d3": "\"\\uFEFFbom\"\n", "d4": "\"\\uFEFFbom\"\n", "d5": "\"\\uFEFFbom\"\n", "d6": "\"\\uFEFFbom\"\n", "d7": "--- \"\\uFEFFbom\"\n"}], ["a\u0007b", {"d0": "\"a\\ab\"\n", "d1": "\"a\\ab\"\n", "d2": "\"a\\ab\"\n", "d3": "\"a\\ab\"\n", "d4": "\"a\\ab\"\n", "d5": "\"a\\ab\"\n", "d6": "\"a\\ab\"\n", "d7": "--- \"a\\ab\"\n"}]];

const CORE_PACK_HASHES: Record<string, [string, string, string]> = { "core_pack/extensions/agent-context/agent-context-config.yml": [ "6ad5db65a89a60e3", "33728b15a5ba83c0", "e0d8fc86123426cf" ], "core_pack/extensions/agent-context/extension.yml": [ "5c20c606248cb6a4", "0f299d60cd923a3a", "df49f1923309e4c1" ], "core_pack/extensions/assess/extension.yml": [ "5ccd702dcc5c234f", "9804bdde6bf1640e", "524e017846d1a411" ], "core_pack/extensions/bug/extension.yml": [ "a5f6117145662359", "ea28b91df8f1e6cb", "cec8642a493de62e" ], "core_pack/extensions/git/config-template.yml": [ "ea6474a1a5202177", "cb77b5f6b085af26", "7fb20f62b32522cd" ], "core_pack/extensions/git/extension.yml": [ "dce32069c1d0b393", "8568d52fde271813", "c3ba06365353bad0" ], "core_pack/extensions/git/git-config.yml": [ "ea6474a1a5202177", "cb77b5f6b085af26", "7fb20f62b32522cd" ], "core_pack/presets/constitution-sync/preset.yml": [ "ab913267c89dec02", "bb851b1ae57a0b81", "5a252799999cd764" ], "core_pack/presets/lean/preset.yml": [ "3b676176dcf2a642", "44dc83df66a6e6bb", "fa71c21e9f2f1743" ], "core_pack/workflows/assess/workflow.yml": [ "15229a6dabf4d9c5", "50ce95c5cd0bb988", "72adcebe7a7a24c5" ], "core_pack/workflows/bugfix/workflow.yml": [ "9f9af41eddcbf634", "dc56ee3ce0b4589c", "f6e9cdf9f16b2e9c" ], "core_pack/workflows/speckit/workflow.yml": [ "8c51f6d613c511d2", "3d8bbf335b71e505", "f544e6d3032bb126" ], "core_pack/commands/analyze.md#frontmatter": [ "5dc1a87a7d90ce5d", "92cf0ca7ae819439", "8428632443ab9cc3" ], "core_pack/commands/checklist.md#frontmatter": [ "cfa1cc2c5a9797f1", "4f86e8a6433c1093", "41eefd1c305752ac" ], "core_pack/commands/clarify.md#frontmatter": [ "d96ffb6c2cd24b3c", "f20ee4d40bd79261", "b3d7b740bc7f4a5d" ], "core_pack/commands/constitution.md#frontmatter": [ "9e94910598061f08", "7285d57ab7c1749d", "cafb33e2058b8689" ], "core_pack/commands/converge.md#frontmatter": [ "74e490f792914a91", "85f51457a1d97a15", "e72ee077586985ef" ], "core_pack/commands/implement.md#frontmatter": [ "00889e492c70c85c", "461d0f02d2c326a7", "a1eefc92c8bbeb8f" ], "core_pack/commands/plan.md#frontmatter": [ "a1fb39ac980f7a32", "392bd8fbe1795d7d", "81bfc6bfaf516bf0" ], "core_pack/commands/specify.md#frontmatter": [ "de1c869a319c924a", "2d0f271927ce38cb", "f3073f5015757d8b" ], "core_pack/commands/tasks.md#frontmatter": [ "b1adf5236058984b", "153205f0a45b4eb3", "2386c077d20721f8" ], "core_pack/commands/taskstoissues.md#frontmatter": [ "bd6b794e3e4f115e", "5d6f701b9b71e548", "a872129ad74b0028" ], "core_pack/extensions/agent-context/commands/speckit.agent-context.update.md#frontmatter": [ "5990ac9bfa13bd32", "354cde88c6a59d5e", "354cde88c6a59d5e" ], "core_pack/extensions/assess/commands/speckit.assess.decide.md#frontmatter": [ "a60916b20be84e30", "8101199d4b4ad80e", "8101199d4b4ad80e" ], "core_pack/extensions/assess/commands/speckit.assess.define.md#frontmatter": [ "5e310102aa77803e", "e33142bc50486713", "e33142bc50486713" ], "core_pack/extensions/assess/commands/speckit.assess.intake.md#frontmatter": [ "7681c08dab9a1005", "05377309d8a26ffb", "05377309d8a26ffb" ], "core_pack/extensions/assess/commands/speckit.assess.research.md#frontmatter": [ "94b2dbe73a9424a7", "4922b4cb8d4170ff", "468256eb5ab236b0" ], "core_pack/extensions/assess/commands/speckit.assess.shape.md#frontmatter": [ "0b18bd08d1bc96ec", "838d8b08abd4c130", "838d8b08abd4c130" ], "core_pack/extensions/bug/commands/speckit.bug.assess.md#frontmatter": [ "fc0547375e40c53a", "e9aadf02b7541a3f", "e9aadf02b7541a3f" ], "core_pack/extensions/bug/commands/speckit.bug.fix.md#frontmatter": [ "505f1eb7ad3ecfd8", "b735f345531a64d4", "b735f345531a64d4" ], "core_pack/extensions/bug/commands/speckit.bug.test.md#frontmatter": [ "dcbb71c7178440c1", "b2b8c54b28c9cb55", "b2b8c54b28c9cb55" ], "core_pack/extensions/git/commands/speckit.git.commit.md#frontmatter": [ "4f04fc3be8e98e2b", "25a8dd2a0056fadc", "25a8dd2a0056fadc" ], "core_pack/extensions/git/commands/speckit.git.feature.md#frontmatter": [ "f831d7268827cc04", "ccfef117d62a6f5a", "ccfef117d62a6f5a" ], "core_pack/extensions/git/commands/speckit.git.initialize.md#frontmatter": [ "fd36623742659eed", "07d25cb304db3184", "07d25cb304db3184" ], "core_pack/extensions/git/commands/speckit.git.remote.md#frontmatter": [ "eef4edaac5119f72", "7d3fbd3083c48077", "7d3fbd3083c48077" ], "core_pack/extensions/git/commands/speckit.git.validate.md#frontmatter": [ "9b3586bbd672af04", "68dc6604fd8a4160", "68dc6604fd8a4160" ], "core_pack/presets/constitution-sync/commands/speckit.constitution.md#frontmatter": [ "2d6b599e92e9e90c", "35152cc9a71cc841", "3eaee8ce36689771" ], "core_pack/presets/lean/commands/speckit.constitution.md#frontmatter": [ "9448afd767b0accd", "a07c5d8c4cd689aa", "a07c5d8c4cd689aa" ], "core_pack/presets/lean/commands/speckit.implement.md#frontmatter": [ "aef9c3c04f717f81", "91fc2c8f0a5aa253", "91fc2c8f0a5aa253" ], "core_pack/presets/lean/commands/speckit.plan.md#frontmatter": [ "c4409242a23ac2d5", "f36b0452537fd084", "f36b0452537fd084" ], "core_pack/presets/lean/commands/speckit.specify.md#frontmatter": [ "ef65adfaabaa9745", "2ff48902ff0e7427", "2ff48902ff0e7427" ], "core_pack/presets/lean/commands/speckit.tasks.md#frontmatter": [ "f540e46e6ba84e8d", "3248614daa804007", "3248614daa804007" ], "core_pack/templates/tasks-template.md#frontmatter": [ "c833a042f1d99579", "08d77791ba112411", "08d77791ba112411" ]};

// ============================================================================
// Helpers
// ============================================================================

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  return v;
}

function canon(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

function sha16(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

function frontmatter(text: string): string | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end > 0 ? text.slice(4, end + 1) : null;
}

const REPO = path.resolve(import.meta.dir, '..');
const UPSTREAM = process.env.SPEC_KIT_UPSTREAM ?? '';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ============================================================================
// safe_load parity
// ============================================================================

describe('parseYaml matches PyYAML safe_load', () => {
  for (const [text, expected, err] of PARSE_CASES) {
    test(JSON.stringify(text).slice(0, 70), () => {
      if (err !== undefined) {
        let message = '';
        try {
          parseYaml(text);
        } catch (e) {
          expect(e).toBeInstanceOf(YAMLError);
          message = (e as Error).message;
        }
        expect(message).toBe(err);
      } else {
        expect(canon(parseYaml(text))).toBe(canon(expected));
      }
    });
  }
});

describe('parseYaml semantics', () => {
  test('YAML 1.1 scalars', () => {
    expect(parseYaml('a: yes\nb: off\nc: ~\nd: 0x1f\ne: 1_000\nf: .5\ng: 1e3\nh: 0755\ni: "007"')).toEqual({
      a: true, b: false, c: null, d: 31, e: 1000, f: 0.5, g: '1e3', h: 493, i: '007',
    });
  });
  test('timestamps stay strings by default, Date on request', () => {
    expect(parseYaml('d: 2024-01-02')).toEqual({ d: '2024-01-02' });
    const d = parseYaml('d: 2024-01-02', { timestamps: 'date' }) as { d: Date };
    expect(d.d).toBeInstanceOf(Date);
    expect(d.d.toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });
  test('anchors share identity and merge keys', () => {
    const v = parseYaml('base: &b\n  x: 1\nderived:\n  <<: *b\n  y: 2\nsame: *b') as Record<string, Record<string, number>>;
    expect(v.derived).toEqual({ x: 1, y: 2 });
    expect(v.same).toBe(v.base);
  });
  test('block scalars', () => {
    expect(parseYaml('a: |\n  x\n  y\nb: >-\n  p\n  q\n')).toEqual({ a: 'x\ny\n', b: 'p q' });
  });
  test('empty document is null; errors are typed', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('# comment only\n')).toBeNull();
    expect(() => parseYaml('a: [1')).toThrow(ParserError);
    expect(() => parseYaml('a: b: c')).toThrow(ScannerError);
    expect(() => parseYaml('a: 1\n---\nb: 2')).toThrow(ComposerError);
    expect(() => parseYaml('a: !custom x')).toThrow(ConstructorError);
    expect(() => parseYaml('a: *nope')).toThrow(ComposerError);
  });
  test('name option appears in marks', () => {
    try {
      parseYaml('a: b: c', { name: 'extension.yml' });
      throw new Error('expected failure');
    } catch (e) {
      expect((e as Error).message).toContain('in "extension.yml", line 1, column 5');
    }
  });
  test('__proto__ keys are data, not prototype', () => {
    const v = parseYaml('__proto__: {polluted: true}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(v, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test('non-printable characters are rejected like PyYAML reader', () => {
    expect(() => parseYaml('a: \x07')).toThrow('unacceptable character #x0007: special characters are not allowed');
  });
  test('BOM and CRLF line endings', () => {
    expect(parseYaml('﻿a: 1\r\nb:\r\n  - x\r\n')).toEqual({ a: 1, b: ['x'] });
  });
});

describe('isEmptyYamlDocument / yamlHasNode (yaml.compose idiom)', () => {
  test.each([
    ['', true],
    ['   \n# c\n', true],
    ['---\n', true],
    ['null', false],
    ['~', false],
    ['[]', false],
    ["''", false],
    ['false', false],
  ])('%j -> %p', (text, empty) => {
    expect(isEmptyYamlDocument(text)).toBe(empty);
  });
  test('yamlHasNode', () => {
    expect(yamlHasNode('')).toBe(false);
    expect(yamlHasNode('null')).toBe(true);
  });
});

// ============================================================================
// safe_dump parity
// ============================================================================

const DUMP_OPTS: Record<string, Parameters<typeof dumpYaml>[1]> = {
  d0: {},
  d1: { sortKeys: false, allowUnicode: true },
  d2: { defaultFlowStyle: null },
  d3: { defaultFlowStyle: true },
  d4: { indent: 4 },
  d5: { width: 40 },
  d6: { defaultStyle: '"', allowUnicode: true, width: 1e9 },
  d7: { explicitStart: true },
};

describe('dumpYaml matches PyYAML safe_dump', () => {
  DUMP_CASES.forEach(([value, expected], idx) => {
    for (const [key, opts] of Object.entries(DUMP_OPTS)) {
      test(`case ${idx} ${key}: ${JSON.stringify(value).slice(0, 50)}`, () => {
        expect(dumpYaml(value, opts)).toBe(expected[key]);
      });
    }
  });
  test('round-trips through parseYaml', () => {
    for (const [value] of DUMP_CASES) {
      // PyYAML itself does not round-trip raw NEL/LS/PS line breaks.
      if (/[\u0085\u2028\u2029]/.test(JSON.stringify(value)) || JSON.stringify(value).includes('\\u0085')) continue;
      for (const opts of Object.values(DUMP_OPTS)) {
        expect(canon(parseYaml(dumpYaml(value, opts)))).toBe(canon(value));
      }
    }
  });
  test('shared objects become anchors/aliases', () => {
    const shared = { a: 1 };
    expect(dumpYaml({ x: shared, y: shared })).toBe('x: &id001\n  a: 1\ny: *id001\n');
  });
  test('undefined properties are skipped', () => {
    expect(dumpYaml({ a: 1, b: undefined })).toBe('a: 1\n');
  });
});

// ============================================================================
// Real files
// ============================================================================

describe('core_pack YAML parity (hashes from PyYAML)', () => {
  for (const [rel, [valueHash, dumpHash, dump2Hash]] of Object.entries(CORE_PACK_HASHES)) {
    test(rel, () => {
      const [file, fm] = rel.split('#');
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      const src = fm ? frontmatter(text)! : text;
      const value = parseYaml(src);
      expect(sha16(JSON.stringify(sortDeep(value)).replace(/[\u007f-￿]/g, (c) => c))).toBe(valueHash);
      expect(sha16(dumpYaml(value))).toBe(dumpHash);
      expect(sha16(dumpYaml(value, { sortKeys: false, allowUnicode: true }))).toBe(dump2Hash);
      expect(canon(parseYaml(dumpYaml(value)))).toBe(canon(value));
    });
  }
});

describe('every repo core_pack YAML/frontmatter parses', () => {
  const files = walk(path.join(REPO, 'core_pack'));
  test('all *.yml/*.yaml and *.md frontmatter', () => {
    let count = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      if (/\.ya?ml$/.test(f)) {
        const v = parseYaml(text, { name: f });
        expect(canon(parseYaml(dumpYaml(v)))).toBe(canon(v));
        count++;
      } else if (f.endsWith('.md')) {
        const fm = frontmatter(text);
        if (fm !== null) {
          const v = parseYaml(fm);
          expect(canon(parseYaml(dumpYaml(v, { sortKeys: false, allowUnicode: true })))).toBe(canon(v));
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(20);
  });
});

describe.skipIf(!UPSTREAM || !fs.existsSync(UPSTREAM))('upstream clone YAML parses without error', () => {
  test('extensions/ presets/ workflows/ bundles/ templates/ yml + md frontmatter', () => {
    let count = 0;
    for (const sub of ['extensions', 'presets', 'workflows', 'bundles', 'templates', 'integrations', 'src/specify_cli/core_pack']) {
      for (const f of walk(path.join(UPSTREAM, sub))) {
        const text = fs.readFileSync(f, 'utf8');
        if (/\.ya?ml$/.test(f)) {
          const v = parseYaml(text);
          expect(canon(parseYaml(dumpYaml(v)))).toBe(canon(v));
          count++;
        } else if (f.endsWith('.md')) {
          const fm = frontmatter(text);
          if (fm !== null) {
            parseYaml(fm);
            count++;
          }
        }
      }
    }
    expect(count).toBeGreaterThan(20);
  });
});
