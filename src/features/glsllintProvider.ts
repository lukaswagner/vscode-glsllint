import * as child_process from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as glslify from 'glslify';
import { GLSLifyProvider } from './glslifyProvider';
import { GLSLifyUriMapper } from './glslifyUriMapper';
import * as ts from 'typescript';
import { stageExpressions } from './glslStageExpression';
import { WebpackProvider } from './webpackProvider';
import { WebpackUriMapper } from './webpackUriMapper';

enum glslValidatorFailCodes {
  ESuccess = 0,
  EFailUsage,
  EFailCompile,
  EFailLink,
  EFailCompilerCreate,
  EFailThreadCreate,
  EFailLinkerCreate
}

enum MessageSeverity {
  Info,
  Warning,
  Error
}

interface StringLiteral {
  text: string;
  startLine: number;
  //end: number;
  stage: string;
}

interface StageExpression {
  stage: string;
  expression: RegExp;
}

export class GLSLLintingProvider {
  //private static commandId: string = 'glsllint.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private readonly ENV_RESOLVE_REGEX = /\$\{(.*?)\}/g;
  private readonly config = vscode.workspace.getConfiguration('glsllint');

  public activate(subscriptions: vscode.Disposable[]) {
    //this.command = vscode.commands.registerCommand(GLSLLintingProvider.commandId, this.runCodeAction, this);
    subscriptions.push(this);
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();

    vscode.workspace.onDidOpenTextDocument(this.doLint, this, subscriptions);
    vscode.workspace.onDidCloseTextDocument(
      (textDocument) => {
        this.diagnosticCollection.delete(textDocument.uri);
      },
      null,
      subscriptions
    );

    vscode.workspace.onDidSaveTextDocument(this.doLint, this);

    vscode.workspace.textDocuments.forEach(this.doLint, this);
  }

  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }

  private showMessage(msg: string, severity: MessageSeverity): void {
    const showMsg = `GLSL Lint: ${msg}`;

    switch (severity) {
      case MessageSeverity.Info:
        vscode.window.showInformationMessage(showMsg);
        break;
      case MessageSeverity.Warning:
        vscode.window.showWarningMessage(showMsg);
        break;
      case MessageSeverity.Error:
        vscode.window.showErrorMessage(showMsg);
    }
  }

  private getValidatorPath(): string {
    const config = vscode.workspace.getConfiguration('glsllint');
    let glslangValidatorPath = config.glslangValidatorPath;

    if (glslangValidatorPath === null || glslangValidatorPath === '') {
      glslangValidatorPath = 'glslangValidator';
    }

    // try to replace the env variables in glslangValidatorPath
    // format: "glsllint.glslangValidatorPath": "${env:MY_ENV}/path/to/glslangValidator"
    glslangValidatorPath = glslangValidatorPath.replace(this.ENV_RESOLVE_REGEX, (match: string, variable: string) => {
      const parts = variable.split(':');
      let resolved = variable;
      if (parts.length > 1) {
        const argument = parts[1];
        switch (parts[0]) {
          case 'env': // only support 'env' for environment substitution for the moment
            const env = process.env[argument];
            if (env) {
              resolved = env;
            } else {
              this.showMessage(
                `GLSL Lint: Failed to resolve environment variable '${argument}'`,
                MessageSeverity.Error
              );
            }
            break;
          default:
            this.showMessage(
              `GLSL Lint: Resolving via '${variable}' is not supported, only 'env:YOUR_ENV_VARIABLE' is supported.`,
              MessageSeverity.Error
            );
            break;
        }
      }

      return resolved;
    });

    try {
      fs.accessSync(glslangValidatorPath, fs.constants.R_OK);
    } catch (error) {
      this.showMessage(
        `GLSL Lint: glslangValidator binary is not available:
        ${error.message}
        Please check your glsllint.glslangValidatorPath setting.`,
        MessageSeverity.Error
      );
      return '';
    }

    return glslangValidatorPath;
  }

  /**
   * get all string literals (even ES6 template literals) from the TypeScript compiler node (recursive)
   */
  private getStringLiterals(
    inputNode: ts.Node,
    currentLiterals: StringLiteral[],
    sourceFile: ts.SourceFile
  ): StringLiteral[] {
    // check for generic!
    let stringLiterals: StringLiteral[] = currentLiterals;
    ts.forEachChild(inputNode, (currentNode: ts.Node) => {
      /*
      console.log(`kind: ${currentNode.kind}`);
      console.log(`text: "${currentNode.getFullText(sourceFile)}"`);
      */
      if (
        currentNode.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        currentNode.kind === ts.SyntaxKind.StringLiteral
      ) {
        stringLiterals.push({
          text: (currentNode as ts.LiteralLikeNode).text,
          startLine: sourceFile.getLineAndCharacterOfPosition(currentNode.getStart(sourceFile)).line,
          //end: currentNode.getEnd(),
          stage: 'unknown'
        });
      } else {
        stringLiterals = this.getStringLiterals(currentNode, stringLiterals, sourceFile);
      }
    });
    return stringLiterals;
  }

  private getShaderStageFromFile(fileName: string): string {
    const extension = path.extname(fileName);

    const stageMapping = {
      '.vert': 'vert', // for a vertex shader
      '.vs': 'vert', // for a vertex shader
      '.frag': 'frag', // for a fragment shader
      '.fs': 'frag', // for a fragment shader
      '.gs': 'geom', // for a geometry shader
      '.geom': 'geom', // for a geometry shader
      '.comp': 'comp', // for a compute shader
      '.tesc': 'tesc', // for a tessellation control shader
      '.tese': 'tese', // for a tessellation evaluation shader
      '.rgen': 'rgen', // for a ray generation shader
      '.rint': 'rint', // for a ray intersection shader
      '.rahit': 'rahit', // for a ray any hit shader
      '.rchit': 'rchit', // for a ray closest shader
      '.rmiss': 'rmiss', // for a ray miss shader
      '.rcall': 'rcall', // for a ray callable shader
      '.mesh': 'mesh', // for a mesh shader
      '.task': 'task' // for a task shader
    };

    const additionalStageMappings = this.config.additionalStageAssociations;
    const mergedStageMappings = { ...stageMapping, ...additionalStageMappings };

    const stage = mergedStageMappings[extension];

    if (!stage) {
      this.showMessage(
        `GLSL Lint: failed to map extension: '${extension}', you can add it to the extension setting 'glsllint.additionalStageAssociations'`,
        MessageSeverity.Error
      );
    }

    return stage;
  }

  private getShaderStageFromText(shaderCode: string): string {
    for (const shaderExp of stageExpressions) {
      if (shaderCode.match(shaderExp.expression)) {
        return shaderExp.stage;
      }
    }

    // if not automatically matched, then do a fallback via #pragma
    const pragmaRegEx = /#pragma\svscode_glsllint_stage\s*:\s*(\S*)/gm;
    const match = pragmaRegEx.exec(shaderCode);
    if (match && match.length === 2) {
      return match[1];
    }

    // if not match then show error
    const errorMsg = `The shader stage could not be determined automatically.
    Please add: 
    '#pragma vscode_glsllint_stage: STAGE'
    to the shader code. Where STAGE is a valid shader stage (e.g.: 'vert' or 'frag', see 'Available stages' in the docs)`;
    this.showMessage(errorMsg, MessageSeverity.Error);

    return 'unknown';
  }

  private getShaderLiterals(literals: StringLiteral[]): StringLiteral[] {
    const isShaderRegex = /main\s*\(.*\)\s*\{/gm;

    const shaderLiterals = literals.filter((literal) => {
      // check if this literal is a shader
      if (literal.text.match(isShaderRegex)) {
        literal.stage = this.getShaderStageFromText(literal.text);
        return true;
      }
      return false;
    });

    return shaderLiterals;
  }

  private async doLint(textDocument: vscode.TextDocument): Promise<void> {
    const languageId = textDocument.languageId;
    let parseStringLiterals = false;

    if (languageId !== 'glsl') {
      // check if we have should support the language for string literal parsing
      parseStringLiterals = this.config.supportedLangsWithStringLiterals.includes(languageId);
      if (!parseStringLiterals) {
        return;
      }
    }

    const glsifiedSuffix = '(glslified)';

    if (textDocument.fileName.endsWith(glsifiedSuffix)) {
      // skip
      return;
    }

    let fileContent = textDocument.getText();
    let diagnostics: vscode.Diagnostic[] = [];
    let docUri = textDocument.uri;

    if (parseStringLiterals) {
      // hints about TS AST: https://ts-ast-viewer.com
      // process a file which contains string literals (e.g. JavaScript or TypeScript)
      /*
      const tsProgram = ts.createProgram([textDocument.fileName], { allowJs: true });
      const sourceFile = tsProgram.getSourceFile(textDocument.fileName);
      */
      const sourceFile = ts.createSourceFile(textDocument.fileName, fileContent, ts.ScriptTarget.ES2015);
      let stringLiterals: StringLiteral[] = [];
      stringLiterals = this.getStringLiterals(sourceFile, stringLiterals, sourceFile);

      stringLiterals = this.getShaderLiterals(stringLiterals);

      for (const literal of stringLiterals) {
        const literalDiagnostics = await this.lintShaderCode(literal.text, literal.stage);
        // correct the code ranges

        for (const literalDiagnostic of literalDiagnostics) {
          literalDiagnostic.range = new vscode.Range(
            literalDiagnostic.range.start.line + literal.startLine,
            0,
            literalDiagnostic.range.end.line + literal.startLine,
            0
          );
        }
        diagnostics = [...diagnostics, ...literalDiagnostics];
      }
    } else {
      const glslifyRegEx = new RegExp(this.config.glslifyPattern, 'gm');
      const glslifyUsed = glslifyRegEx.test(fileContent);

      if (glslifyUsed) {
        try {
          fileContent = glslify.file(textDocument.fileName);
        } catch (error) {
          this.showMessage(
            `GLSL Lint: failed to compile the glslify file!\n${error.toString()}`,
            MessageSeverity.Error
          );
          return;
        }
      }

      const webpackRegEx = /@import ([.\/\w_-]+);/gi;
      const webpackUsed = webpackRegEx.test(fileContent);

      if (webpackUsed) {
        fileContent = fileContent.replace(webpackRegEx, (match, p1) => {
          const file =
            path.join(path.dirname(textDocument.fileName), p1) + '.glsl';
          const content = fs.readFileSync(file, { encoding: 'UTF-8' });
          return content;
        })
      }

      const stage = this.getShaderStageFromFile(textDocument.fileName);
      diagnostics = await this.lintShaderCode(fileContent, stage);

      if (glslifyUsed) {
        const glslifyFileName = path.basename(textDocument.fileName);
        const glslifyUri = vscode.Uri.parse(`${GLSLifyProvider.scheme}:${glslifyFileName}-${glsifiedSuffix}`);
        GLSLifyUriMapper.add(glslifyUri, fileContent);

        const glslifyTextDocument = await vscode.workspace.openTextDocument(glslifyUri);
        await vscode.window.showTextDocument(glslifyTextDocument);
        await vscode.languages.setTextDocumentLanguage(glslifyTextDocument, 'glsl');
      }

      if (webpackUsed) {
        const webpackFileExt = path.extname(textDocument.fileName);
        const webpackFileName = path.basename(textDocument.fileName, webpackFileExt);
        const webpackUri = vscode.Uri.parse(`${WebpackProvider.scheme}:${webpackFileName}.combined${webpackFileExt}`);
        WebpackUriMapper.add(webpackUri, fileContent);

        const webpackTextDocument = await vscode.workspace.openTextDocument(webpackUri);
        await vscode.window.showTextDocument(webpackTextDocument);
        await vscode.languages.setTextDocumentLanguage(webpackTextDocument, 'glsl');
      }
    }
    this.diagnosticCollection.set(docUri, diagnostics);
  }

  private async lintShaderCode(source: string, stage: string): Promise<vscode.Diagnostic[]> {
    const glslangValidatorPath = this.getValidatorPath();
    if (glslangValidatorPath === '') {
      return;
    }

    let diagnostics: vscode.Diagnostic[] = [];

    // Split the arguments string from the settings
    let args = this.config.glslangValidatorArgs.split(/\s+/).filter((arg) => arg);

    args.push('--stdin');
    args.push('-S');
    args.push(stage);

    let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;

    let childProcess = child_process.spawn(glslangValidatorPath, args, options);
    childProcess.stdin.write(source);
    childProcess.stdin.end();

    let stdOutData = '';
    for await (const chunk of childProcess.stdout) {
      stdOutData += chunk;
    }

    let stdErrorData = '';
    for await (const chunk of childProcess.stderr) {
      stdErrorData += chunk;
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      childProcess.on('close', resolve);
    });

    if (exitCode === glslValidatorFailCodes.EFailUsage) {
      // general error when starting glsl validator
      const message = `Wrong parameters when starting glslangValidator.
      Arguments:
      ${args.join('\n')}
      stderr:
      ${stdErrorData}
      `;
      this.showMessage(message, MessageSeverity.Error);
    } else if (exitCode !== glslValidatorFailCodes.ESuccess) {
      let lines = stdOutData.toString().split(/(?:\r\n|\r|\n)/g);
      for (const line of lines) {
        if (line !== '' && line !== 'stdin') {
          let severity: vscode.DiagnosticSeverity = undefined;

          if (line.startsWith('ERROR:')) {
            severity = vscode.DiagnosticSeverity.Error;
          }
          if (line.startsWith('WARNING:')) {
            severity = vscode.DiagnosticSeverity.Warning;
          }

          if (severity !== undefined) {
            let matches = line.match(/WARNING:|ERROR:\s.+?(?=:(\d)+):(\d*): (\W.*)/);
            if (matches && matches.length === 4) {
              let message = matches[3];
              let errorline = parseInt(matches[2]);
              let range = new vscode.Range(errorline - 1, 0, errorline - 1, 0);
              let diagnostic = new vscode.Diagnostic(range, message, severity);
              diagnostics.push(diagnostic);
            }
          }
        }
      }
    }

    return diagnostics;
  }
}
