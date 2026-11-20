/**
 * 一个极小但完整的数学表达式求值器（不使用 eval，避免代码注入）。
 *
 * 文法（递归下降，优先级从低到高）：
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/' | '%') factor)*
 *   factor     := unary ('**' factor)?        // 右结合
 *   unary      := ('+' | '-') unary | primary
 *   primary    := number | ident '(' args ')' | ident | '(' expression ')'
 */

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' | '**' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  log: Math.log,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  factorial: (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('factorial 只支持 0~170 的整数');
    let acc = 1;
    for (let i = 2; i <= n; i += 1) acc *= i;
    return acc;
  },
};

function tokenize(input: string): Token[] {
  const src = input.replace(/\s+/g, '');
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i += 1;
      if (i < src.length && /[eE]/.test(src[i])) {
        i += 1;
        if (src[i] === '+' || src[i] === '-') i += 1;
        while (i < src.length && /[0-9]/.test(src[i])) i += 1;
      }
      const raw = src.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`非法数字：${raw}`);
      tokens.push({ type: 'number', value });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i += 1;
      tokens.push({ type: 'ident', value: src.slice(start, i).toLowerCase() });
      continue;
    }

    if (ch === '*' && src[i + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      i += 2;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',' || ch === '，') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }
    throw new Error(`不支持的字符：${ch}`);
  }

  return tokens;
}

export function evaluateExpression(input: string): number {
  if (!input.trim()) throw new Error('表达式为空');
  if (input.length > 300) throw new Error('表达式过长（>300 字符）');

  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isOp = (value: string): boolean => {
    const t = peek();
    return !!t && t.type === 'op' && t.value === value;
  };

  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      if (isOp('+')) {
        pos += 1;
        value += parseTerm();
      } else if (isOp('-')) {
        pos += 1;
        value -= parseTerm();
      } else {
        return value;
      }
    }
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      if (isOp('*')) {
        pos += 1;
        value *= parseFactor();
      } else if (isOp('/')) {
        pos += 1;
        const rhs = parseFactor();
        if (rhs === 0) throw new Error('除数为 0');
        value /= rhs;
      } else if (isOp('%')) {
        pos += 1;
        value %= parseFactor();
      } else {
        return value;
      }
    }
  }

  function parseFactor(): number {
    const base = parseUnary();
    if (isOp('**')) {
      pos += 1;
      const exponent = parseFactor(); // 右结合：2**3**2 = 2**(3**2)
      if (Math.abs(exponent) > 512) throw new Error('指数过大（|exp| > 512）');
      return base ** exponent;
    }
    return base;
  }

  function parseUnary(): number {
    if (isOp('-')) {
      pos += 1;
      return -parseUnary();
    }
    if (isOp('+')) {
      pos += 1;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const token = peek();
    if (!token) throw new Error('表达式意外结束');

    if (token.type === 'number') {
      pos += 1;
      return token.value;
    }

    if (token.type === 'lparen') {
      pos += 1;
      const value = parseExpression();
      if (peek()?.type !== 'rparen') throw new Error('缺少右括号');
      pos += 1;
      return value;
    }

    if (token.type === 'ident') {
      pos += 1;
      const name = token.value;
      if (peek()?.type === 'lparen') {
        pos += 1;
        const args: number[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseExpression());
          while (peek()?.type === 'comma') {
            pos += 1;
            args.push(parseExpression());
          }
        }
        if (peek()?.type !== 'rparen') throw new Error(`函数 ${name} 缺少右括号`);
        pos += 1;
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`不支持的函数：${name}`);
        return fn(...args);
      }
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`未知标识符：${name}`);
    }

    throw new Error(`无法解析的符号：${JSON.stringify(token)}`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('表达式存在多余内容，请检查括号或运算符');
  if (Number.isNaN(result)) throw new Error('计算结果不是有效数字');
  return result;
}

/** 给前端 / 模型展示用的格式化：整数不带小数点，小数最多 10 位有效数字 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return Number.parseFloat(value.toPrecision(10)).toString();
}
