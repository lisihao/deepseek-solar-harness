/** Owned JavaScript analyzer evaluated inside the bounded QuickJS Worker. */
export const QUICKJS_ANALYZE_SOURCE = String.raw`
function analyzeCell(source, ts) {
  const input = ts.createSourceFile('cell.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (input.parseDiagnostics.length) throw new Error('invalid TypeScript cell');
  const forbidden = node => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || ts.isExportDeclaration(node) || ts.isExportAssignment(node)
      || node.kind === ts.SyntaxKind.ImportKeyword
      || node.modifiers?.some(value => value.kind === ts.SyntaxKind.ExportKeyword || value.kind === ts.SyntaxKind.DefaultKeyword)) {
      throw new Error('QuickJS cells do not load or export modules');
    }
    ts.forEachChild(node, forbidden);
  };
  forbidden(input);
  const emitted = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, alwaysStrict: true },
  }).outputText;
  const file = ts.createSourceFile('cell.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [];
  const names = name => ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : names(element.name));
  const register = (name, kind) => {
    if (name.startsWith('__dsh') || ['context', 'rlm', 'console'].includes(name)) throw new Error('reserved QuickJS binding: ' + name);
    if (declarations.some(value => value.name === name)) throw new Error('duplicate QuickJS binding: ' + name);
    declarations.push({ name, kind });
  };
  const rejectOuterReturn = node => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) throw new Error('cell return must be a final expression');
    ts.forEachChild(node, rejectOuterReturn);
  };
  for (const statement of file.statements) {
    rejectOuterReturn(statement);
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const declaration of statement.declarationList.declarations) {
        for (const name of names(declaration.name)) register(name, kind);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      register(statement.name.text, ts.isFunctionDeclaration(statement) ? 'function' : 'class');
    }
  }
  const last = file.statements.at(-1);
  const expression = last && ts.isExpressionStatement(last) ? last.expression.getText(file) : 'undefined';
  const body = last && ts.isExpressionStatement(last) ? emitted.slice(0, last.getStart(file)) : emitted;
  const bindings = declarations.map(({ name, kind }) => '{name:' + JSON.stringify(name)
    + ',kind:' + JSON.stringify(kind) + ',get:()=>'+name
    + (kind === 'const' ? '' : ',set:(__dshNext)=>{'+name+'=__dshNext}') + '}').join(',');
  return {
    names: declarations.map(value => value.name),
    code: '(async()=>{\"use strict\";\n' + body + '\nconst __dshValue=(' + expression
      + '); __dshPublish([' + bindings + ']); return __dshValue;})',
  };
}
`
