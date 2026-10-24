const toolDefinitions = {
  calculator: {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a basic arithmetic expression. No variables, code, or function calls.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', maxLength: 200 } },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
  get_utc_time: {
    type: 'function',
    function: {
      name: 'get_utc_time',
      description: 'Get the current time in UTC.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
};

function selectTools(tools = []) {
  if (!Array.isArray(tools) || tools.length > 8) throw new Error('invalid_tools');
  const selected = [];
  const names = new Set();
  for (const item of tools) {
    const name = item?.type === 'function' ? item.function?.name : undefined;
    if (typeof name !== 'string' || !toolDefinitions[name]) throw new Error('unsupported_tool');
    if (names.has(name)) throw new Error('duplicate_tool');
    names.add(name);
    selected.push(toolDefinitions[name]);
  }
  return { definitions: selected, names };
}

function executeTool(name, args) {
  if (!toolDefinitions[name]) throw new Error('unsupported_tool');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
  if (name === 'get_utc_time') {
    if (Object.keys(args).length) throw new Error('get_utc_time takes no arguments.');
    return { utc: new Date().toISOString() };
  }
  if (name === 'calculator') {
    if (typeof args.expression !== 'string' || args.expression.length > 200 || Object.keys(args).some(key => key !== 'expression')) {
      throw new Error('Provide one arithmetic expression up to 200 characters.');
    }
    return { result: evaluateArithmetic(args.expression) };
  }
  throw new Error('unsupported_tool');
}

function evaluateArithmetic(source) {
  const tokens = source.match(/\s*(?:(\d+(?:\.\d*)?|\.\d+)|([()+\-*/%^]))/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== source.replace(/\s/g, '') || tokens.length > 100) {
    throw new Error('Expression contains unsupported characters or is too long.');
  }
  const normalized = tokens.map(token => token.trim());
  let index = 0;
  const peek = () => normalized[index];
  const consume = () => normalized[index++];
  const expression = () => {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const term = () => {
    let value = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = consume();
      const right = power();
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('Division by zero is not allowed.');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  const power = () => {
    const value = unary();
    if (peek() === '^') {
      consume();
      return value ** power();
    }
    return value;
  };
  const unary = () => {
    if (peek() === '+') { consume(); return unary(); }
    if (peek() === '-') { consume(); return -unary(); }
    return atom();
  };
  const atom = () => {
    if (peek() === '(') {
      consume();
      const value = expression();
      if (consume() !== ')') throw new Error('Unmatched parenthesis.');
      return value;
    }
    const token = consume();
    if (!token || !/^\d+(?:\.\d*)?$|^\.\d+$/.test(token)) throw new Error('Expected a number.');
    return Number(token);
  };
  const value = expression();
  if (index !== normalized.length || !Number.isFinite(value)) throw new Error('Expression is incomplete or outside the supported numeric range.');
  return value;
}

module.exports = { selectTools, executeTool, evaluateArithmetic };
