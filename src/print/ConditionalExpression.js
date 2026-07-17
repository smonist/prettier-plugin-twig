import { doc } from "prettier";
import { Node } from "../melody/melody-types/index.js";
import {
    EXPRESSION_NEEDED,
    STRING_NEEDS_QUOTES,
    wrapExpressionIfNeeded
} from "../util/index.js";

const { line, indent, group } = doc.builders;

const printConditionalExpression = (node, path, print) => {
    node[EXPRESSION_NEEDED] = false;
    node[STRING_NEEDS_QUOTES] = true;

    const rest = [line, "?"];
    if (node.consequent) {
        rest.push([" ", path.call(print, "consequent")]);
    }
    if (node.alternate) {
        rest.push(line, ": ", path.call(print, "alternate"));
    }
    // Preserve author-written parentheses around the test, e.g.
    // "(a ?? b) ? x : y" or a nested "(a ? b : c) ? x : y"
    const testNeedsParens =
        node.test.wasParenthesized === true &&
        (Node.isBinaryExpression(node.test) ||
            Node.isConditionalExpression(node.test));
    const printedTest = path.call(print, "test");
    const parts = [
        testNeedsParens ? ["(", printedTest, ")"] : printedTest,
        indent(rest)
    ];
    wrapExpressionIfNeeded(path, parts, node);

    return group(parts);
};

export { printConditionalExpression };
