
/* IMPORT */

import * as _ from 'lodash';
import * as absolute from 'absolute';
import * as findUp from 'find-up';
import * as fs from 'fs';
import * as isBinaryPath from 'is-binary-path';
import * as mkdirp from 'mkdirp';
import * as moment from 'moment';
import * as path from 'path';
import * as pify from 'pify';
import stringMatches from 'string-matches';
import * as vscode from 'vscode';
import * as Commands from './commands';
import Config from './config';
import Consts from './consts';

/* UTILS */

const Utils = {

  initCommands ( context: vscode.ExtensionContext ) {

    const {commands, keybindings} = vscode.extensions.getExtension ( 'fabiospampinato.vscode-todo-plus' ).packageJSON.contributes;

    commands.forEach ( ({ command, title }) => {

      if ( !_.includes ( ['todo.open', 'todo.openEmbedded'], command ) ) return;

      const commandName = _.last ( command.split ( '.' ) ) as string,
            handler = Commands[commandName],
            disposable = vscode.commands.registerCommand ( command, () => handler () );

      context.subscriptions.push ( disposable );

    });

    keybindings.forEach ( ({ command }) => {

      if ( _.includes ( ['todo.open', 'todo.openEmbedded'], command ) ) return;

      const commandName = _.last ( command.split ( '.' ) ) as string,
            disposable = vscode.commands.registerTextEditorCommand ( command, Commands[commandName] );

      context.subscriptions.push ( disposable );

    });

    return Commands;

  },

  initLanguage () {

    vscode.languages.setLanguageConfiguration ( Consts.languageId, {
      wordPattern: /(-?\d*\.\d\w*)|([^\-\`\~\!\#\%\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
      indentationRules: {
        increaseIndentPattern: Consts.regexes.project,
        decreaseIndentPattern: Consts.regexes.impossible
      }
    });

  },

  getAllMatches ( str: string, regex: RegExp, multi: boolean = true ) {

    regex = multi ? new RegExp ( regex.source, 'gm' ) : regex;

    let match,
        matches = [];

    while ( match = regex.exec ( str ) ) {

      matches.push ( match );

    }

    return matches;

  },

  matches2ranges ( matches: RegExpMatchArray[] ) {

    return matches.map ( Utils.match2range );

  },

  match2range ( match: RegExpMatchArray ) {

    const first = _.first ( match ),
          last = _.last ( match ),
          start = match.index + first.indexOf ( last ),
          end = start + last.length;

    return {start, end};

  },

  parseGlobs ( globs ) {

    return `{${_.castArray ( globs ).join ( ',' )}}`;

  },

  editor: {

    isSupported ( textEditor?: vscode.TextEditor ) {

      return textEditor && ( textEditor.document.languageId === Consts.languageId );

    },

    makeReplaceEdit ( lineNr: number, replacement: string, fromCh: number, toCh?: number ) {

      const range = new vscode.Range ( lineNr, fromCh, lineNr, toCh || fromCh ),
            replace = vscode.TextEdit.replace ( range, replacement );

      return replace;

    },

    applyEdits ( textEditor: vscode.TextEditor, edits: vscode.TextEdit[] ) {

      const uri = textEditor.document.uri,
            edit = new vscode.WorkspaceEdit ();

      edit.set ( uri, edits );

      return vscode.workspace.applyEdit ( edit );

    },

    open ( content ) {

      vscode.workspace.openTextDocument ({ language: Consts.languageId }).then ( ( textDocument: vscode.TextDocument ) => {

        vscode.window.showTextDocument ( textDocument ).then ( ( textEditor: vscode.TextEditor ) => {

          textEditor.edit ( edit => {

            const pos = new vscode.Position ( 0, 0 );

            edit.insert ( pos, content );

            textEditor.document.save ();

          });

        });

      });

    },

    async getDoc ( file ) {

      try { // Maybe the file is binary or something

        return await vscode.workspace.openTextDocument ( file );

      } catch ( e ) {}

    }

  },

  file: {

    open ( filepath, isTextDocument = true ) {

      filepath = path.normalize ( filepath );

      const fileuri = vscode.Uri.file ( filepath );

      if ( isTextDocument ) {

        return vscode.workspace.openTextDocument ( fileuri )
                                .then ( vscode.window.showTextDocument );

      } else {

        return vscode.commands.executeCommand ( 'vscode.open', fileuri );

      }

    },

    async read ( filepath ) {

      try {
        return ( await pify ( fs.readFile )( filepath, { encoding: 'utf8' } ) ).toString ();
      } catch ( e ) {
        return;
      }

    },

    readSync ( filepath ) {

      try {
        return ( fs.readFileSync ( filepath, { encoding: 'utf8' } ) ).toString ();
      } catch ( e ) {
        return;
      }

    },

    async make ( filepath, content ) {

      await pify ( mkdirp )( path.dirname ( filepath ) );

      return Utils.file.write ( filepath, content );

    },

    async write ( filepath, content ) {

      return pify ( fs.writeFile )( filepath, content, {} );

    }

  },

  folder: {

    getRootPath ( basePath? ) {

      const {workspaceFolders} = vscode.workspace;

      if ( !workspaceFolders ) return;

      const firstRootPath = workspaceFolders[0].uri.fsPath;

      if ( !basePath || !absolute ( basePath ) ) return firstRootPath;

      const rootPaths = workspaceFolders.map ( folder => folder.uri.fsPath ),
            sortedRootPaths = _.sortBy ( rootPaths, [path => path.length] ).reverse (); // In order to get the closest root

      return sortedRootPaths.find ( rootPath => basePath.startsWith ( rootPath ) );

    },

    async getWrapperPathOf ( rootPath, cwdPath, findPath ) {

      const foundPath = await findUp ( findPath, { cwd: cwdPath } );

      if ( foundPath ) {

        const wrapperPath = path.dirname ( foundPath );

        if ( wrapperPath.startsWith ( rootPath ) ) {

          return wrapperPath;

        }

      }

    }

  },

  todo: {

    getFiles ( folderPath ) {

      const config = Config.get (),
            {extensions} = vscode.extensions.getExtension ( 'fabiospampinato.vscode-todo-plus' ).packageJSON.contributes.languages[0],
            files = _.uniq ([ config.file, ...extensions ]);

      return files.map ( file => path.join ( folderPath, file ) );

    },

    get ( folderPath ) {

      const files = Utils.todo.getFiles ( folderPath );

      for ( let file of files ) {

        const content = Utils.file.readSync ( file );

        if ( _.isUndefined ( content ) ) continue;

        return {
          path: file,
          content
        };

      }

    }

  },

  embedded: {

    getRegex () {

      const config = Config.get ();

      return new RegExp ( config.embedded.regex, 'g' );

    },

    async getFiles () {

      const config = Config.get (),
            {include, exclude, limit} = config.embedded,
            files = await vscode.workspace.findFiles ( Utils.parseGlobs ( include ), Utils.parseGlobs ( exclude ), limit ),
            filesText = files.filter ( file => !isBinaryPath ( file.fsPath ) );

      return filesText;

    },

    async getFilesTodos ( files, regex ) {

      const todos = {}; // { [TYPE] => { [FILE] => [{ LINE, NR }] } }

      for ( let file of files ) {

        const doc = await Utils.editor.getDoc ( file );

        if ( !doc ) continue;

        const filePath = doc.uri.fsPath;

        for ( let lineNr = 0, lineNrs = doc.lineCount; lineNr < lineNrs; lineNr++ ) {

          const line = doc.lineAt ( lineNr ).text,
                matches = stringMatches ( line, regex );

          for ( let match of matches ) {

            const type = match[1];

            if ( !todos[type] ) todos[type] = {};

            if ( !todos[type][filePath] ) todos[type][filePath] = [];

            todos[type][filePath].push ({ line, lineNr });

          }

        }

      }

      return todos;

    },

    renderTodos ( todos ) {

      const config = Config.get (),
            { indentation, embedded: { groupByFile }, symbols: { box } } = config,
            lines = [];

      /* LINES */

      const types = Object.keys ( todos ).sort ();

      types.forEach ( type => {

        const files = todos[type];

        lines.push ( `${type}:` );

        const filePaths = Object.keys ( files ).sort ();

        filePaths.forEach ( filePath => {

          const todos = files[filePath],
                normalizedFilePath = `/${_.trimStart ( filePath, '/' )}`;

          if ( groupByFile ) {
            lines.push ( `${indentation}@file://${normalizedFilePath}` );
          }

          todos.forEach ( ({ line, lineNr }) => {

            lines.push ( `${indentation}${groupByFile ? indentation : ''}${box} ${_.trimStart ( line )} @file://${normalizedFilePath}#${lineNr + 1}` );

          });

        });

      });

      return lines.length ? `${lines.join ( '\n' )}\n` : '';

    }

  }

};

/* EXPORT */

export default Utils;
