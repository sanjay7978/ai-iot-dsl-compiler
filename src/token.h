// token.h — token definitions shared by the lexer and the parser.
#pragma once

#include <string>
#include <vector>

enum class TokenType {
    // Keywords
    IF, THEN, ELSE, AND, OR, NOT, SENSOR, DEVICE,
    TYPE_NUMBER, TYPE_STATE,                      // sensor types: NUMBER, STATE
    ON, OFF, OPEN, CLOSED, TRUE_KW, FALSE_KW,     // state literals

    // Names and literals
    IDENTIFIER, NUMBER,

    // Relational and arithmetic operators
    GT, LT, GE, LE, EQ, NE,
    PLUS, MINUS, STAR, SLASH,

    // Punctuation
    LPAREN, RPAREN, COMMA, COLON,

    END_OF_FILE
};

struct Token {
    TokenType type;
    std::string lexeme;
    int line;     // 1-based
    int col;      // 1-based, counted in characters
    int length;   // length in characters (tokens never span lines)
};

// Position in the source text (1-based line and column).
struct Pos {
    int line = 0;
    int col = 0;
};

// A suggested edit that repairs a problem (like an IDE "quick fix"):
// replace `length` characters at line:col with `text` (length 0 = insert).
struct Fix {
    std::string title;
    int line;
    int col;
    int length;
    std::string text;
};

// One error or warning produced by any compiler phase.
struct Diagnostic {
    std::string phase;    // "lexical", "syntax" or "semantic"
    int line;
    int col;
    int length;
    std::string message;
    std::string severity = "error";   // "error" or "warning"
    std::vector<Fix> fixes = {};       // suggested repairs (may be empty)
};

// Name printed in the token table, e.g. "IF", "IDENTIFIER", "GT".
inline const char* tokenTypeName(TokenType t) {
    switch (t) {
        case TokenType::IF:          return "IF";
        case TokenType::THEN:        return "THEN";
        case TokenType::ELSE:        return "ELSE";
        case TokenType::AND:         return "AND";
        case TokenType::OR:          return "OR";
        case TokenType::NOT:         return "NOT";
        case TokenType::SENSOR:      return "SENSOR";
        case TokenType::DEVICE:      return "DEVICE";
        case TokenType::TYPE_NUMBER: return "TYPE_NUMBER";
        case TokenType::TYPE_STATE:  return "TYPE_STATE";
        case TokenType::ON:          return "ON";
        case TokenType::OFF:         return "OFF";
        case TokenType::OPEN:        return "OPEN";
        case TokenType::CLOSED:      return "CLOSED";
        case TokenType::TRUE_KW:     return "TRUE";
        case TokenType::FALSE_KW:    return "FALSE";
        case TokenType::IDENTIFIER:  return "IDENTIFIER";
        case TokenType::NUMBER:      return "NUMBER";
        case TokenType::GT:          return "GT";
        case TokenType::LT:          return "LT";
        case TokenType::GE:          return "GE";
        case TokenType::LE:          return "LE";
        case TokenType::EQ:          return "EQ";
        case TokenType::NE:          return "NE";
        case TokenType::PLUS:        return "PLUS";
        case TokenType::MINUS:       return "MINUS";
        case TokenType::STAR:        return "STAR";
        case TokenType::SLASH:       return "SLASH";
        case TokenType::LPAREN:      return "LPAREN";
        case TokenType::RPAREN:      return "RPAREN";
        case TokenType::COMMA:       return "COMMA";
        case TokenType::COLON:       return "COLON";
        case TokenType::END_OF_FILE: return "EOF";
    }
    return "UNKNOWN";
}

// Broad token class: keyword, state, identifier, number, operator, punctuation.
inline const char* tokenCategory(TokenType t) {
    switch (t) {
        case TokenType::ON: case TokenType::OFF: case TokenType::OPEN:
        case TokenType::CLOSED: case TokenType::TRUE_KW: case TokenType::FALSE_KW:
            return "state";
        case TokenType::IDENTIFIER:
            return "identifier";
        case TokenType::NUMBER:
            return "number";
        case TokenType::GT: case TokenType::LT: case TokenType::GE:
        case TokenType::LE: case TokenType::EQ: case TokenType::NE:
        case TokenType::PLUS: case TokenType::MINUS: case TokenType::STAR: case TokenType::SLASH:
            return "operator";
        case TokenType::LPAREN: case TokenType::RPAREN:
        case TokenType::COMMA: case TokenType::COLON:
            return "punctuation";
        case TokenType::END_OF_FILE:
            return "eof";
        default:
            return "keyword";
    }
}
