import * as vscode from 'vscode';
import { WebpackUriMapper } from './webpackUriMapper';

export class WebpackProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public static scheme = 'wpglsl';

  constructor() { }

  dispose() {
    this._onDidChange.dispose();
  }

  public provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
    return WebpackUriMapper.get(uri);
  }

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this._onDidChange.event;
  }
}
