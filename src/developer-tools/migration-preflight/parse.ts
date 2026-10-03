import ts from "typescript";
import type { MigrationDefinition } from "./compare.js";

function definitionTokens(node: ts.Node, file: ts.SourceFile): string {
  const tokens: Array<[number, string]> = [];
  const visit = (current: ts.Node): void => {
    if (ts.isJSDoc(current)) return;
    const children = current.getChildren(file);
    if (children.length) children.forEach(visit);
    else tokens.push([current.kind, current.getText(file)]);
  };
  visit(node);
  return JSON.stringify(tokens);
}

/** Static syntax only: never evaluate initializers, imports, SQL or migration callbacks. */
export function parseMigrations(source: string): MigrationDefinition[] {
  const file = ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // parseDiagnostics is present on parser-produced SourceFiles but omitted from the public interface.
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error("schema.ts: TypeScript syntax error");
  const declarations = file.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "MIGRATIONS");
  const initializer = declarations[0]?.initializer;
  if (declarations.length !== 1 || !initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error("schema.ts: expected one literal MIGRATIONS array");
  }
  const versions = new Set<number>();
  return initializer.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("MIGRATIONS: expected literal objects");
    const properties = new Map<string, ts.ObjectLiteralElementLike>();
    for (const property of element.properties) {
      if (!property.name || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        throw new Error("MIGRATIONS: spread or computed property is unsupported");
      }
      const key = property.name.text;
      if (properties.has(key)) throw new Error(`MIGRATIONS: duplicate property ${key}`);
      properties.set(key, property);
    }
    const versionProperty = properties.get("version");
    const nameProperty = properties.get("name");
    if (!versionProperty || !ts.isPropertyAssignment(versionProperty)
      || !ts.isNumericLiteral(versionProperty.initializer)
      || !nameProperty || !ts.isPropertyAssignment(nameProperty)
      || !ts.isStringLiteral(nameProperty.initializer)
      || !properties.has("source") || !properties.has("up")) {
      throw new Error("MIGRATIONS: requires literal version/name and source/up");
    }
    const version = Number(versionProperty.initializer.text);
    if (!Number.isSafeInteger(version) || version <= 0 || versions.has(version)) {
      throw new Error(`MIGRATIONS: invalid or duplicate version ${version}`);
    }
    versions.add(version);
    return { version, name: nameProperty.initializer.text,
      definition: definitionTokens(element, file) };
  });
}
