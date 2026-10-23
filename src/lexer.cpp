// lexer.cpp — hand-written scanner for the IoT DSL.
//
// The scanner reads the source one character at a time and groups characters
// into tokens using the longest-match (maximal munch) rule, e.g. ">=" is one
// GE token, not GT followed by an error.

#include "lexer.h"

#include <cctype>
#include <unordered_map>
#include <utility>

namespace {

const std::unordered_map<std::string, TokenType> kKeywords = {
    {"IF", TokenType::IF},           {"THEN", TokenType::THEN},
    {"ELSE", TokenType::ELSE},       {"AND", TokenType::AND},
    {"OR", TokenType::OR},           {"NOT", TokenType::NOT},
    {"SENSOR", TokenType::SENSOR},   {"DEVICE", TokenType::DEVICE},
    {"NUMBER", TokenType::TYPE_NUMBER},
    {"STATE", TokenType::TYPE_STATE},
    {"ON", TokenType::ON},           {"OFF", TokenType::OFF},
    {"OPEN", TokenType::OPEN},       {"CLOSED", TokenType::CLOSED},
    {"TRUE", TokenType::TRUE_KW},    {"FALSE", TokenType::FALSE_KW},
};

bool isIdentStart(char c) {
    unsigned char u = static_cast<unsigned char>(c);
    return std::isalpha(u) || c == '_';
}

bool isIdentChar(char c) {
    unsigned char u = static_cast<unsigned char>(c);
    return std::isalnum(u) || c == '_';
}

bool isDigit(char c) {
    return std::isdigit(static_cast<unsigned char>(c)) != 0;
}

// True for the 2nd..4th bytes of a multi-byte UTF-8 character.
bool isUtf8Continuation(char c) {
    return (static_cast<unsigned char>(c) & 0xC0) == 0x80;
}

}  // namespace

bool lookupKeyword(const std::string& word, TokenType& type) {
    auto it = kKeywords.find(word);
    if (it == kKeywords.end()) return false;
    type = it->second;
    return true;
}

Lexer::Lexer(std::string source) : src_(std::move(source)) {}

char Lexer::peek(size_t ahead) const {
    size_t i = pos_ + ahead;
    return i < src_.size() ? src_[i] : '\0';
}

// Consumes one byte and keeps line/column up to date. Columns count
// characters, so UTF-8 continuation bytes do not advance the column.
char Lexer::advance() {
    char c = src_[pos_++];
    if (c == '\n') {
        ++line_;
        col_ = 1;
    } else if (!isUtf8Continuation(c)) {
        ++col_;
    }
    return c;
}

void Lexer::skipWhitespaceAndComments() {
    while (!atEnd()) {
        char c = peek();
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            advance();
        } else if (c == '#') {               // comment runs to end of line
            while (!atEnd() && peek() != '\n') advance();
        } else {
            break;
        }
    }
}

Token Lexer::makeToken(TokenType type, size_t start, int line, int col) const {
    return Token{type, src_.substr(start, pos_ - start), line, col, col_ - col};
}

void Lexer::error(int line, int col, int length, const std::string& message) {
    errors_.push_back(Diagnostic{"lexical", line, col, length, message});
}

// identifier := (letter | '_') (letter | digit | '_')*
// A lexeme that matches the keyword table becomes that keyword token.
Token Lexer::scanIdentifierOrKeyword() {
    size_t start = pos_;
    int line = line_, col = col_;
    while (!atEnd() && isIdentChar(peek())) advance();

    Token tok = makeToken(TokenType::IDENTIFIER, start, line, col);
    TokenType kw;
    if (lookupKeyword(tok.lexeme, kw)) tok.type = kw;
    return tok;
}

// number := digit+ ('.' digit+)?
Token Lexer::scanNumber() {
    size_t start = pos_;
    int line = line_, col = col_;
    while (!atEnd() && isDigit(peek())) advance();

    if (peek() == '.') {
        if (isDigit(peek(1))) {
            advance();                                   // '.'
            while (!atEnd() && isDigit(peek())) advance();
        } else {
            Token tok = makeToken(TokenType::NUMBER, start, line, col);
            int dotCol = col_;
            advance();                                   // skip the stray '.'
            error(line, dotCol, 1,
                  "malformed number '" + tok.lexeme + ".': expected a digit after '.'");
            return tok;
        }
    }

    Token tok = makeToken(TokenType::NUMBER, start, line, col);

    // Reject things like "30C" or "12abc": a number must not run into a name.
    if (isIdentStart(peek())) {
        size_t suffixStart = pos_;
        while (!atEnd() && isIdentChar(peek())) advance();
        std::string whole = tok.lexeme + src_.substr(suffixStart, pos_ - suffixStart);
        error(line, col, col_ - col,
              "invalid numeric literal '" + whole + "' (numbers cannot contain letters)");
    }
    return tok;
}

std::vector<Token> Lexer::tokenize() {
    std::vector<Token> tokens;

    while (true) {
        skipWhitespaceAndComments();
        if (atEnd()) {
            tokens.push_back(Token{TokenType::END_OF_FILE, "", line_, col_, 0});
            break;
        }

        char c = peek();
        if (isIdentStart(c)) { tokens.push_back(scanIdentifierOrKeyword()); continue; }
        if (isDigit(c))      { tokens.push_back(scanNumber());              continue; }

        size_t start = pos_;
        int line = line_, col = col_;
        advance();

        switch (c) {
            case '(': tokens.push_back(makeToken(TokenType::LPAREN, start, line, col)); break;
            case ')': tokens.push_back(makeToken(TokenType::RPAREN, start, line, col)); break;
            case ',': tokens.push_back(makeToken(TokenType::COMMA, start, line, col));  break;
            case ':': tokens.push_back(makeToken(TokenType::COLON, start, line, col));  break;
            case '+': tokens.push_back(makeToken(TokenType::PLUS, start, line, col));   break;
            case '-': tokens.push_back(makeToken(TokenType::MINUS, start, line, col));  break;
            case '*': tokens.push_back(makeToken(TokenType::STAR, start, line, col));   break;
            case '/': tokens.push_back(makeToken(TokenType::SLASH, start, line, col));  break;

            case '>':
                if (peek() == '=') advance();
                tokens.push_back(makeToken(pos_ - start == 2 ? TokenType::GE : TokenType::GT,
                                           start, line, col));
                break;

            case '<':
                if (peek() == '=') advance();
                tokens.push_back(makeToken(pos_ - start == 2 ? TokenType::LE : TokenType::LT,
                                           start, line, col));
                break;

            case '=':
                if (peek() == '=') {
                    advance();
                    tokens.push_back(makeToken(TokenType::EQ, start, line, col));
                } else {
                    // Error recovery: report it, then treat '=' as '==' so the
                    // parser can keep checking the rest of the rule.
                    error(line, col, 1, "unexpected '=': assignment is not supported, did you mean '=='?");
                    Token tok = makeToken(TokenType::EQ, start, line, col);
                    tok.lexeme = "==";
                    tokens.push_back(tok);
                }
                break;

            case '!':
                if (peek() == '=') {
                    advance();
                    tokens.push_back(makeToken(TokenType::NE, start, line, col));
                } else {
                    error(line, col, 1, "unexpected character '!': use NOT for negation or '!=' for not-equal");
                }
                break;

            default: {
                // Swallow the whole UTF-8 character so the message shows it intact.
                while (!atEnd() && isUtf8Continuation(peek())) advance();
                std::string bad = src_.substr(start, pos_ - start);
                error(line, col, 1, "unexpected character '" + bad + "'");
                break;
            }
        }
    }
    return tokens;
}
