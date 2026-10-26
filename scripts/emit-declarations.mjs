import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const configPath = resolve('tsconfig.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const host = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

function report(diagnostics) {
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  }
  return diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

if (configFile.error && report([configFile.error])) process.exit(1);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
if (report(config.errors)) process.exit(1);

function rewriteImports(context) {
  return (sourceFile) => {
    function rewrite(specifier) {
      if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.') || /\.[^/]+$/.test(specifier.text)) {
        return specifier;
      }

      const target = resolve(dirname(sourceFile.fileName), specifier.text);
      if (existsSync(`${target}.ts`) || existsSync(`${target}.tsx`)) {
        return ts.factory.createStringLiteral(`${specifier.text}.js`);
      }
      if (existsSync(join(target, 'index.ts'))) {
        return ts.factory.createStringLiteral(`${specifier.text}/index.js`);
      }
      throw new Error(`Cannot resolve ${specifier.text} in ${sourceFile.fileName}`);
    }

    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        return ts.factory.updateImportDeclaration(
          node, node.modifiers, node.importClause, rewrite(node.moduleSpecifier), node.attributes
        );
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        return ts.factory.updateExportDeclaration(
          node, node.modifiers, node.isTypeOnly, node.exportClause, rewrite(node.moduleSpecifier), node.attributes
        );
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const argument = ts.factory.updateLiteralTypeNode(node.argument, rewrite(node.argument.literal));
        return ts.factory.updateImportTypeNode(
          node, argument, node.attributes, node.qualifier, node.typeArguments, node.isTypeOf
        );
      }
      return ts.visitEachChild(node, visit, context);
    }

    return ts.visitNode(sourceFile, visit);
  };
}

function compilerOptions(outDir) {
  return { ...config.options, outDir: resolve(outDir), emitDeclarationOnly: true };
}

if (process.argv.includes('--watch')) {
  for (const outDir of ['dist', 'dist/cjs']) {
    const watchHost = ts.createWatchCompilerHost(
      configPath,
      compilerOptions(outDir),
      ts.sys,
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      (diagnostic) => report([diagnostic]),
      (diagnostic) => report([diagnostic])
    );
    watchHost.afterProgramCreate = (builder) => {
      const program = builder.getProgram();
      if (report(ts.getPreEmitDiagnostics(program))) return;
      report(builder.emit(undefined, undefined, undefined, true, {
        afterDeclarations: [rewriteImports],
      }).diagnostics);
    };
    ts.createWatchProgram(watchHost);
  }
} else {
  for (const outDir of ['dist', 'dist/cjs']) {
    const program = ts.createProgram(config.fileNames, compilerOptions(outDir));
    if (report(ts.getPreEmitDiagnostics(program))) process.exit(1);
    const emitted = program.emit(undefined, undefined, undefined, true, {
      afterDeclarations: [rewriteImports],
    });
    if (report(emitted.diagnostics) || emitted.emitSkipped) process.exit(1);
  }
}
