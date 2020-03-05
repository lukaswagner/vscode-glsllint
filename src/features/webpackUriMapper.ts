import * as vscode from 'vscode';

export class WebpackUriMapper {
  private static _instance: WebpackUriMapper;
  private _map: Map<string, string>;

  private constructor() {
    this._map = new Map<string, string>();
  }

  public static getInstance(): WebpackUriMapper {
    if (!WebpackUriMapper._instance) {
      WebpackUriMapper._instance = new WebpackUriMapper();
    }

    return WebpackUriMapper._instance;
  }

  public static add(uri: vscode.Uri, content: string): void {
    WebpackUriMapper.getInstance()._map.set(uri.toString(), content);
  }

  public static get(uri: vscode.Uri): string {
    const ret =
      WebpackUriMapper.getInstance()._map.get(uri.toString());
    return ret || '';
  }
}
