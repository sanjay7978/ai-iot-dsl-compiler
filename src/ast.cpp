// ast.cpp — converts AST nodes to DisplayNode and prints trees.

#include "ast.h"

DisplayNode Node::makeDisplay(const std::string& kind, const std::string& label) const {
    DisplayNode d;
    d.kind = kind;
    d.label = label;
    d.start = start;
    d.end = end;
    return d;
}

DisplayNode Operand::display() const {
    switch (kind) {
        case OperandKind::Identifier: return makeDisplay("ident", "Identifier: " + text);
        case OperandKind::Number:     return makeDisplay("number", "Number: " + text);
        case OperandKind::State:      return makeDisplay("state", "State: " + text);
    }
    return makeDisplay("ident", text);
}

DisplayNode LogicalCond::display() const {
    DisplayNode d = makeDisplay("logic", op);
    d.children.push_back(left->display());
    d.children.push_back(right->display());
    return d;
}

DisplayNode NotCond::display() const {
    DisplayNode d = makeDisplay("logic", "NOT");
    d.children.push_back(operand->display());
    return d;
}

DisplayNode Comparison::display() const {
    DisplayNode d = makeDisplay("compare", "Comparison: " + op);
    d.children.push_back(lhs.display());
    d.children.push_back(rhs.display());
    return d;
}

DisplayNode Action::display() const {
    DisplayNode d = makeDisplay("action", "Action: " + name);
    for (const Operand& arg : args) d.children.push_back(arg.display());
    return d;
}

DisplayNode SensorDecl::display() const {
    DisplayNode d = makeDisplay("decl", "Sensor Declaration");
    d.children.push_back(name.display());
    DisplayNode t;
    t.kind = "type";
    t.label = "Type: " + type;
    t.start = typeStart;
    t.end = typeEnd;
    d.children.push_back(t);
    return d;
}

DisplayNode DeviceDecl::display() const {
    DisplayNode d = makeDisplay("decl", "Device Declaration");
    for (const Operand& n : names) d.children.push_back(n.display());
    return d;
}

namespace {

// Groups a list of actions under a "Then"/"Else" heading node.
DisplayNode actionBlock(const std::string& label, const std::vector<Action>& actions) {
    DisplayNode block;
    block.kind = "block";
    block.label = label;
    if (!actions.empty()) {
        block.start = actions.front().start;
        block.end = actions.back().end;
    }
    for (const Action& a : actions) block.children.push_back(a.display());
    return block;
}

}  // namespace

DisplayNode Rule::display() const {
    DisplayNode d = makeDisplay("rule", "Rule");

    DisplayNode cond;
    cond.kind = "block";
    cond.label = "Condition";
    cond.start = condition->start;
    cond.end = condition->end;
    cond.children.push_back(condition->display());
    d.children.push_back(cond);

    d.children.push_back(actionBlock("Then", thenActions));
    if (!elseActions.empty()) d.children.push_back(actionBlock("Else", elseActions));
    return d;
}

DisplayNode Program::display() const {
    DisplayNode d = makeDisplay("program", "Program");
    for (const auto& s : statements) d.children.push_back(s->display());
    return d;
}

// ---------- Printers -------------------------------------------------------

namespace {

void printTreeRec(const DisplayNode& node, std::ostream& out,
                  const std::string& prefix, bool last) {
    out << prefix << (last ? "└── " : "├── ") << node.label << "\n";
    std::string childPrefix = prefix + (last ? "    " : "│   ");
    for (size_t i = 0; i < node.children.size(); ++i)
        printTreeRec(node.children[i], out, childPrefix, i + 1 == node.children.size());
}

std::string dotEscape(const std::string& s) {
    std::string r;
    for (char c : s) {
        if (c == '"' || c == '\\') r += '\\';
        r += c;
    }
    return r;
}

int printDotRec(const DisplayNode& node, std::ostream& out, int& nextId) {
    int id = nextId++;
    out << "  n" << id << " [label=\"" << dotEscape(node.label) << "\"];\n";
    for (const DisplayNode& child : node.children) {
        int childId = printDotRec(child, out, nextId);
        out << "  n" << id << " -> n" << childId << ";\n";
    }
    return id;
}

}  // namespace

void printTree(const DisplayNode& node, std::ostream& out) {
    out << node.label << "\n";
    for (size_t i = 0; i < node.children.size(); ++i)
        printTreeRec(node.children[i], out, "", i + 1 == node.children.size());
}

void printDot(const DisplayNode& node, std::ostream& out) {
    out << "digraph AST {\n"
        << "  node [shape=box, style=rounded, fontname=\"Helvetica\"];\n";
    int nextId = 0;
    printDotRec(node, out, nextId);
    out << "}\n";
}
