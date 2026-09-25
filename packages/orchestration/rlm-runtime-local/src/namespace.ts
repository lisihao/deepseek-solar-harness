/** TypeScript cell analysis used by the persistent RLM namespace. */

import { stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'

/** Declaration forms the runtime can recreate without pretending V8 serializes closures. */
export type KernelDeclarationKind = 'let' | 'const' | 'var' | 'function' | 'class' | 'import'

/** One top-level binding and the source that originally established it. */
export interface KernelDeclaration {
  readonly name: string
  readonly declaration: KernelDeclarationKind
  readonly source?: string
  readonly sourceId?: string
  readonly sourceKind?: 'binding' | 'declaration' | 'import'
}

/** Executable JavaScript plus the top-level namespace bindings it may update. */
export interface AnalyzedTypeScriptCell {
  readonly code: string
  readonly declarations: readonly KernelDeclaration[]
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function variableKind(list: ts.VariableDeclarationList): 'let' | 'const' | 'var' {
  if ((list.flags & ts.NodeFlags.Const) !== 0) return 'const'
  if ((list.flags & ts.NodeFlags.Let) !== 0) return 'let'
  return 'var'
}

function importReplacement(
  statement: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
): { readonly code: string; readonly declarations: readonly KernelDeclaration[] } {
  const moduleName = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
  if (moduleName === undefined) return { code: statement.getText(sourceFile), declarations: [] }
  const moduleLiteral = JSON.stringify(moduleName)
  const clause = statement.importClause
  if (clause === undefined) return { code: `await import(${moduleLiteral});`, declarations: [] }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return { code: '', declarations: [] }

  const statements: string[] = []
  const declarations: KernelDeclaration[] = []
  if (clause.name !== undefined) {
    const code = `const ${clause.name.text} = (await import(${moduleLiteral})).default;`
    statements.push(code)
    declarations.push({
      name: clause.name.text,
      declaration: 'import',
      source: code,
      sourceId: `import:${String(statement.getStart(sourceFile))}:default`,
      sourceKind: 'import',
    })
  }

  const bindings = clause.namedBindings
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    const code = `const ${bindings.name.text} = await import(${moduleLiteral});`
    statements.push(code)
    declarations.push({
      name: bindings.name.text,
      declaration: 'import',
      source: code,
      sourceId: `import:${String(statement.getStart(sourceFile))}:namespace`,
      sourceKind: 'import',
    })
  } else if (bindings !== undefined) {
    const elements = bindings.elements.filter(element => !element.isTypeOnly)
    if (elements.length > 0) {
      const fields = elements.map((element) => {
        const imported = element.propertyName?.text ?? element.name.text
        return imported === element.name.text ? imported : `${imported}: ${element.name.text}`
      })
      const code = `const { ${fields.join(', ')} } = await import(${moduleLiteral});`
      statements.push(code)
      declarations.push(...elements.map((element) => {
        const imported = element.propertyName?.text ?? element.name.text
        const field = imported === element.name.text ? imported : `${imported}: ${element.name.text}`
        return {
          name: element.name.text,
          declaration: 'import' as const,
          source: `const { ${field} } = await import(${moduleLiteral});`,
          sourceId: `import:${String(statement.getStart(sourceFile))}:named:${element.name.text}`,
          sourceKind: 'import' as const,
        }
      }))
    }
  }
  return { code: statements.join('\n'), declarations }
}

/**
 * Strip erasable TypeScript syntax, convert static imports to top-level-await imports,
 * and enumerate only top-level bindings.
 * @param source - one model-authored TypeScript cell.
 * @returns executable code and conservative restore metadata.
 */
export function analyzeTypeScriptCell(source: string): AnalyzedTypeScriptCell {
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false })
  const sourceFile = ts.createSourceFile('dsh-rlm.ts', stripped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations: KernelDeclaration[] = []
  const output: string[] = []
  let cursor = 0

  for (const statement of sourceFile.statements) {
    const start = statement.getStart(sourceFile)
    output.push(stripped.slice(cursor, start))
    if (ts.isImportDeclaration(statement)) {
      const replacement = importReplacement(statement, sourceFile)
      output.push(replacement.code)
      declarations.push(...replacement.declarations)
    } else {
      const text = stripped.slice(start, statement.end)
      output.push(text)
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        declarations.push({
          name: statement.name.text,
          declaration: 'function',
          source: text,
          sourceId: `declaration:${String(start)}`,
          sourceKind: 'declaration',
        })
      } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        declarations.push({
          name: statement.name.text,
          declaration: 'class',
          source: text,
          sourceId: `declaration:${String(start)}`,
          sourceKind: 'declaration',
        })
      } else if (ts.isVariableStatement(statement)) {
        const declaration = variableKind(statement.declarationList)
        for (const [index, variable] of statement.declarationList.declarations.entries()) {
          const names = bindingNames(variable.name)
          const restoreSource = `${declaration} ${variable.getText(sourceFile)};`
          const sourceId = `binding:${String(start)}:${String(index)}`
          declarations.push(...names.map(name => ({
            name,
            declaration,
            source: restoreSource,
            sourceId,
            sourceKind: 'binding' as const,
          })))
        }
      }
    }
    cursor = statement.end
  }
  output.push(stripped.slice(cursor))
  return { code: output.join(''), declarations }
}
