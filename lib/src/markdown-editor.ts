import CodeMirror from 'codemirror';
import 'codemirror/mode/gfm/gfm.js';
import 'codemirror/addon/display/placeholder.js';
import _ from 'lodash';
import prettier from 'prettier/standalone';
import parserMarkdown from 'prettier/parser-markdown';
import {
  MarkdownEditorOptions,
  FromTextareaOptions,
  MarkdownEditorShortcuts,
  DEFAULT_OPTIONS,
  DEFAULT_FROM_TEXTAREA_OPTIONS,
} from './markdown-editor-options';

class MarkdownEditorBase {
  protected static readonly ORDERED_LIST_PATTERN = /^(\d)+\.(\t| )+/;
  protected static readonly UNORDERED_LIST_PATTERN = /^(\*|-)(\t| )+/;
  protected static readonly BOLD_TOKENS = ['**', '__'];
  protected static readonly ITALIC_TOKENS = ['*', '_'];

  public readonly cm: CodeMirror.Editor;
  protected options: MarkdownEditorOptions;

  constructor(codemirror: CodeMirror.Editor, options: MarkdownEditorOptions) {
    this.cm = codemirror;
    this.options = options;
    this.applyCodemirrorOptions();
    this.applyEditorKeyMappings();
  }

  /***** Basic Editor API *****/

  /**
   * Toggle "bold" for each selection.
   */
  public toggleBold() {
    const preferred = this.options.preferredTokens.bold;
    this.toggleInlineFormatting(
      preferred,
      MarkdownEditorBase.BOLD_TOKENS.filter((t) => t !== preferred)
    );
  }

  /**
   * Toggle "italic" for each selection.
   */
  public toggleItalic() {
    const preferred = this.options.preferredTokens.italic;
    this.toggleInlineFormatting(
      preferred,
      MarkdownEditorBase.ITALIC_TOKENS.filter((t) => t !== preferred)
    );
  }

  /**
   * Toggle "strikethrough" for each selection.
   */
  public toggleStrikethrough() {
    this.toggleInlineFormatting('~~');
  }

  /**
   * Toggle "inline code" for each selection.
   */
  public toggleInlineCode() {
    this.toggleInlineFormatting('`');
  }

  /**
   * Toggle inline formatting for each selection by wrapping it with the specified token
   * and unwrapping it with the specified token or one of the alternative tokens.
   * @param token the token
   * @param altTokens the alternative tokens
   */
  protected toggleInlineFormatting(token: string, altTokens: string[] = []) {
    const newSelections: CodeMirror.Range[] = [];
    const selections = _.cloneDeep(this.cm.listSelections());
    for (let i = 0; i < selections.length; i++) {
      const oldSelection = selections[i];
      const newSelection = _.cloneDeep(oldSelection);

      const from = oldSelection.from();
      const to = oldSelection.to();
      const endLineLength = this.cm.getLine(to.line).length;

      const linePartBefore = this.cm.getRange({ line: from.line, ch: 0 }, from);
      const linePartAfter = this.cm.getRange(to, { line: to.line, ch: endLineLength });
      const prefixToken = [token, ...altTokens].find((t) => {
        return linePartBefore.search(RegExp(escapeRegexChars(t) + '$')) > -1;
      });
      const suffixToken = [token, ...altTokens].find((t) => {
        return linePartAfter.search(RegExp('^' + escapeRegexChars(t))) > -1;
      });

      // indicate whether the tokens before/after the selection have been inserted or deleted
      let beforeShift = 0;
      let afterShift = 0;

      // Insert or delete tokens depending whether they exist

      if (suffixToken) {
        const suffixEnd = {
          line: to.line,
          ch: to.ch <= endLineLength - suffixToken.length ? to.ch + suffixToken.length : endLineLength,
        };
        this.cm.replaceRange('', to, suffixEnd, '+toggleBlock');
        afterShift = -1;
      } else {
        this.cm.replaceRange(token, to, undefined, '+toggleBlock');
        afterShift = 1;
      }

      if (prefixToken) {
        const prefixStart = { line: from.line, ch: from.ch >= prefixToken.length ? from.ch - prefixToken.length : 0 };
        this.cm.replaceRange('', prefixStart, from, '+toggleBlock');
        beforeShift = -1;
      } else {
        this.cm.replaceRange(token, from, undefined, '+toggleBlock');
        beforeShift = 1;
      }

      // Adjust selections to originally selected characters
      if (oldSelection.empty()) newSelection.head = newSelection.anchor;
      else if (from.line === to.line) newSelection.to().ch += beforeShift * token.length;
      newSelection.from().ch += beforeShift * token.length;

      newSelections.push(newSelection);

      // Adjust all following selections to originally selected characters
      for (let j = i + 1; j < selections.length; j++) {
        const s = selections[j];
        if (s.empty()) {
          s.head = s.anchor;
        } else {
          if (s.head.line === from.line) s.head.ch += beforeShift * token.length;
          if (s.head.line === to.line) s.head.ch += afterShift * token.length;
        }
        if (s.anchor.line === from.line) s.anchor.ch += beforeShift * token.length;
        if (s.anchor.line === to.line) s.anchor.ch += afterShift * token.length;
        else break;
      }
    }

    this.cm.setSelections(newSelections, undefined, { origin: '+toggleBlock' });
    this.cm.focus();
  }

  /**
   * Set the specified heading level for each selected line. If `level` is 0, the heading token is removed.
   * @param level the heading level
   */
  public setHeadingLevel(level: 0 | 1 | 2 | 3 | 4 | 5 | 6) {
    const headingToken = '#'.repeat(level) + (level === 0 ? '' : ' ');
    this.replaceTokenAtLineStart((oldLineContent) => oldLineContent.replace(/^((#)*( )?)/, headingToken));
  }

  /**
   * Toggle "quote" for each selected line.
   */
  public toggleQuote() {
    this.replaceTokenAtLineStart((oldLineContent) => {
      // Has selected line a quote token?
      if (oldLineContent.search(/^>(\t| )*/) === -1) {
        return '> ' + oldLineContent;
      } else {
        return oldLineContent.replace(/^>(\t| )*/, '');
      }
    });
  }

  /**
   * Toggle "unordered list" for each selected line. Furthermore, a selected ordered list line is
   * transformed to an unordered list.
   */
  public toggleUnorderedList() {
    const preferred = this.options.preferredTokens.unorderedList + ' ';
    this.replaceTokenAtLineStart((oldLineContent) => {
      // Has selected line a bullet point token?
      if (oldLineContent.search(MarkdownEditorBase.UNORDERED_LIST_PATTERN) === -1) {
        // Has selected line an enumeration token?
        if (oldLineContent.search(MarkdownEditorBase.ORDERED_LIST_PATTERN) === -1) {
          return preferred + oldLineContent;
        } else {
          return oldLineContent.replace(MarkdownEditorBase.ORDERED_LIST_PATTERN, preferred);
        }
      } else {
        return oldLineContent.replace(MarkdownEditorBase.UNORDERED_LIST_PATTERN, '');
      }
    });
  }

  /**
   * Toggle "ordered list" for each selected line. Furthermore, a selected unordered list line is
   * transformed to an ordered list. Additionally adjusts the subsequent lines that are connected
   * to the list of the selected line.
   */
  public toggleOrderedList() {
    this.replaceTokenAtLineStart((oldLineContent, lineNumber) => {
      // Has selected line an enumeration token?
      if (oldLineContent.search(MarkdownEditorBase.ORDERED_LIST_PATTERN) === -1) {
        const prevLine = this.cm.getLine(lineNumber - 1);
        let listNumber: number;

        // Is previous line already enumerated list? -> Determine enumeration token for selected line
        if (!prevLine || prevLine.search(MarkdownEditorBase.ORDERED_LIST_PATTERN) === -1) {
          listNumber = 1;
        } else {
          const dotPos = prevLine.search(/\./);
          listNumber = +prevLine.substring(0, dotPos) + 1;
        }
        this.processNextLinesOfOrderedList(lineNumber, listNumber);
        const numberToken = listNumber + '. ';

        // Has selected line a bullet point token?
        if (oldLineContent.search(MarkdownEditorBase.UNORDERED_LIST_PATTERN) === -1) {
          return numberToken + oldLineContent;
        } else {
          return oldLineContent.replace(MarkdownEditorBase.UNORDERED_LIST_PATTERN, numberToken);
        }
      } else {
        this.processNextLinesOfOrderedList(lineNumber, 0);
        return oldLineContent.replace(MarkdownEditorBase.ORDERED_LIST_PATTERN, '');
      }
    });
  }

  /**
   * Adjust the enumeration of subsequent lines in same ordered list as line *baseLineNumber*.
   * @param baseLineNumber the selected line which is toggled
   * @param baseListNumber the list number of the selected line (should be 0, if list starts after selected line)
   */
  protected processNextLinesOfOrderedList(baseLineNumber: number, baseListNumber: number) {
    let listNumber = baseListNumber;
    let nextLineNumber = baseLineNumber + 1;
    let nextLine = this.cm.getLine(nextLineNumber);
    while (nextLine && nextLine.search(MarkdownEditorBase.ORDERED_LIST_PATTERN) !== -1) {
      const listNumberString = `${++listNumber}`;
      const dotPos = nextLine.search(/\./);
      this.cm.replaceRange(
        listNumberString,
        { line: nextLineNumber, ch: 0 },
        { line: nextLineNumber, ch: dotPos },
        '+replaceTokenAtLineStart'
      );
      nextLine = this.cm.getLine(++nextLineNumber);
    }
  }

  /**
   * Toggle "check list" for each selected line. Furthermore, a selected (un)ordered list line is
   * transformed to a check list.
   */
  public toggleCheckList() {
    // TODO
    // Important: Refactor MarkdownEditor.toggle[Un]orderedList() to also replace check list.
  }

  /**
   * Replace each selected line with the result of the callback function `replaceFn`.
   * Additionally adjusts the selection boundaries to the originally selected boundaries.
   * @param replaceFn callback function to the calculate the line replacements
   */
  protected replaceTokenAtLineStart(replaceFn: (oldLineContent: string, lineNumber: number) => string) {
    const newSelections: CodeMirror.Range[] = [];
    for (const sel of this.cm.listSelections()) {
      const selection = _.cloneDeep(sel);
      let shiftFrom = 0;
      let shiftTo = 0;
      for (let lineNumber = selection.from().line; lineNumber <= selection.to().line; lineNumber++) {
        const oldLineContent = this.cm.getLine(lineNumber);
        const newLineContent = replaceFn(oldLineContent, lineNumber);
        this.cm.replaceRange(
          newLineContent,
          { line: lineNumber, ch: 0 },
          { line: lineNumber, ch: oldLineContent.length },
          '+replaceTokenAtLineStart'
        );

        // Set shifts for selection start and end
        if (lineNumber === selection.from().line) {
          shiftFrom = newLineContent.length - oldLineContent.length;
        }
        if (lineNumber === selection.to().line) {
          shiftTo = newLineContent.length - oldLineContent.length;
        }
      }
      // Adjust selection boundaries to originally selected boundaries
      if (_.isEqual(selection.anchor, selection.from())) {
        selection.anchor.ch += shiftFrom;
        if (!selection.empty()) selection.head.ch += shiftTo;
      } else {
        selection.anchor.ch += shiftTo;
        if (!selection.empty()) selection.head.ch += shiftFrom;
      }
      newSelections.push(selection);
    }

    this.cm.setSelections(newSelections, undefined, { origin: 'replaceTokenAtLineStart' });
    this.cm.focus();
  }

  /**
   * Wrap each selection with code block tokens, which are inserted in separate lines.
   */
  public insertCodeBlock() {
    const newSelections: CodeMirror.Range[] = [];
    const selections = _.cloneDeep(this.cm.listSelections());
    for (let i = 0; i < selections.length; i++) {
      const oldSelection = selections[i];
      const newSelection = _.cloneDeep(oldSelection);
      const preferredToken = this.options.preferredTokens.codeBlock;

      // Wrap selection with code block tokens
      let currentShift = 3;
      let startToken = preferredToken + '\n';
      if (newSelection.from().ch > 0) {
        startToken = '\n' + startToken;
        currentShift++;
      }
      this.cm.replaceRange('\n' + preferredToken + '\n', newSelection.to(), undefined, '+insertCodeBlock');
      this.cm.replaceRange(startToken, newSelection.from(), undefined, '+insertCodeBlock');

      // Adjust selections to originally selected characters
      const offset = newSelection.from().line === newSelection.to().line ? newSelection.from().ch : 0;
      if (!newSelection.empty()) {
        newSelection.to().line += currentShift - 2;
        newSelection.to().ch -= offset;
      } else {
        // fix for edge case bug of empty selection with not synchronous anchor and head
        newSelection.anchor = newSelection.head;
      }
      newSelection.from().line += currentShift - 2;
      newSelection.from().ch = 0;
      newSelections.push(newSelection);

      // Adjust all following selections to originally selected characters
      for (let j = i + 1; j < selections.length; j++) {
        const s = selections[j];
        const remainderIndex = oldSelection.to().ch;
        if (s.from().line === oldSelection.to().line) {
          s.from().ch -= remainderIndex;
        }
        if (s.to().line === oldSelection.to().line) {
          s.to().ch -= remainderIndex;
        }
        if (!s.empty()) s.to().line += currentShift;
        s.from().line += currentShift;
      }
    }

    this.cm.setSelections(newSelections, undefined, { origin: '+insertCodeBlock' });
    this.cm.focus();
  }

  /**
   * Wrap a link template around each selection.
   */
  public insertLink() {
    const [before, after] = this.options.preferredTemplates.link;
    this.insertInlineTemplate(before, after);
  }

  /**
   * Wrap a image link template around each selection.
   */
  public insertImageLink() {
    const [before, after] = this.options.preferredTemplates.imageLink;
    this.insertInlineTemplate(before, after);
  }

  /**
   * Wrap a template around each selection with the specified `before` and `after` template parts.
   * @param before the template part inserted **before** the selection start
   * @param after the template part inserted **after** the selection start
   */
  protected insertInlineTemplate(before: string, after: string) {
    const newSelections: CodeMirror.Range[] = [];
    const selections = this.cm.listSelections();
    for (let i = 0; i < selections.length; i++) {
      const oldSelection = selections[i];
      const newSelection = _.cloneDeep(oldSelection);

      // Insert template parts before and after the selection
      this.cm.replaceRange(after, newSelection.to(), undefined, '+toggleBlock');
      this.cm.replaceRange(before, newSelection.from(), undefined, '+toggleBlock');

      // Adjust selections to originally selected characters
      if (newSelection.empty()) newSelection.head = newSelection.anchor;
      else newSelection.to().ch += before.length;
      newSelection.from().ch += before.length;

      newSelections.push(newSelection);

      // Adjust all following selections to originally selected characters
      for (let j = i + 1; j < selections.length; j++) {
        const s = selections[j];
        if (s.empty()) {
          s.head = s.anchor;
        } else {
          if (s.head.line === oldSelection.from().line) s.head.ch += before.length;
          if (s.head.line === oldSelection.to().line) s.head.ch += after.length;
        }
        if (s.anchor.line === oldSelection.from().line) s.anchor.ch += before.length;
        if (s.anchor.line === oldSelection.to().line) s.anchor.ch += after.length;
        else break;
      }
    }

    this.cm.setSelections(newSelections, undefined, { origin: '+toggleBlock' });
    this.cm.focus();
  }

  /**
   * Insert a horizontal line in the subsequent line of each selection.
   */
  public insertHorizontalLine() {
    const preferred = this.options.preferredTokens.horizontalLine;
    this.insertBlockTemplateBelow(`\n${preferred}\n\n`);
  }

  /**
   * Insert a table template with the specified number of rows and columns
   * in the subsequent line of each selection.
   * @param rows number of rows
   * @param columns number columns
   */
  public insertTable(rows?: number, columns?: number) {
    const tableOptions = this.options.preferredTemplates.table;
    if (typeof tableOptions === 'string') {
      this.insertBlockTemplateBelow(tableOptions);
    } else {
      if (!rows) {
        rows = tableOptions.rows;
      }
      if (!columns) {
        columns = tableOptions.columns;
      }

      let template = '\n';
      for (let c = 1; c <= columns; c++) {
        template += `| Column ${c} `;
      }
      template += '|\n';
      for (let c = 1; c <= columns; c++) {
        template += '| -------- ';
      }
      template += '|\n';
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= columns; c++) {
          template += '| Content  ';
        }
        template += '|\n';
      }
      template += '\n';

      this.insertBlockTemplateBelow(template);
    }
  }

  /**
   * Insert a block template in the subsequent line of each selection.
   * The template can contain multiple lines separated with the specified `lineSeparator`.
   * @param template the template
   * @param lineSeparator The line separator. Default is `\n`.
   */
  protected insertBlockTemplateBelow(template: string, lineSeparator: string = '\n') {
    if (lineSeparator !== '\n') template = template.replace(RegExp(lineSeparator, 'g'), '\n');
    let currentShift = 0; // indicates how many lines have been inserted
    const selections = this.cm.listSelections();
    for (let i = 0; i < selections.length; i++) {
      const oldSelection = selections[i];
      const newSelection = _.cloneDeep(oldSelection);

      // Shift selection back to correct position in respect to previously inserted lines
      if (newSelection.empty()) newSelection.head = newSelection.anchor;
      else newSelection.to().line += currentShift;
      newSelection.from().line += currentShift;

      const toLineNumber = newSelection.to().line;
      const toLineLength = this.cm.getLine(toLineNumber).length;
      const toLineEnd: CodeMirror.Position = { line: toLineNumber, ch: toLineLength };

      if (toLineLength > 0) {
        template = '\n' + template;
      }
      currentShift += template.match(/\n/g)?.length || 0;

      // Insert template in the subsequent line of the selection
      this.cm.replaceRange(template, toLineEnd, undefined, '+insertHorizontalLine');
    }

    this.cm.focus();
  }

  /**
   * Open a Markdown Guide in a new tab.
   */
  public openMarkdownGuide() {
    window.open(this.options.markdownGuideUrl, '_blank');
  }

  /***** Extended Editor API *****/

  /**
   * Undo one edit. Shortcut for `Codemirror.undo()`.
   */
  public undo() {
    this.cm.undo();
  }

  /**
   * Redo one edit. Shortcut for `Codemirror.redo()`.
   */
  public redo() {
    this.cm.redo();
  }

  /**
   * Toggle the editor's rich-text mode. If off, there is no markdown styling inside the editor.
   */
  public toggleRichTextMode() {
    const currentMode = this.cm.getOption('mode');
    if (currentMode === 'gfm') {
      this.cm.setOption('mode', '');
    } else {
      this.cm.setOption('mode', 'gfm');
    }
  }

  /**
   * Start a file download containing the editor content as plain text.
   * The name of the file is either `fileName` if specified, or the default `downloadFileName`
   * specified in the Markdown Editor options.
   * @param fileName The name of the downloaded file. Preferred over `options.downloadFileName`.
   */
  public downloadAsFile(fileName?: string) {
    const data = new Blob([this.getContent()], { type: 'text/plain' });
    const url = window.URL.createObjectURL(data);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', fileName || this.options.downloadFileName); // option
    a.click();
  }

  /**
   * Import content from a file. Reads the content of `file` if specified, or opens the browser's
   * file selection dialog and reads the content of the user-selected file.
   * @param file The file to import the content from.
   */
  public importFromFile(file?: File) {
    const readFile = (file: File) => {
      const reader = new FileReader();
      reader.onload = (event) => this.setContent(((event.target as FileReader).result || '') as string);
      reader.readAsText(file);
    };

    if (file) {
      readFile(file);
    } else {
      const input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', '.txt, .text, .markdown, .mdown, .mkdn, .md, .mkd, .mdwn, .mdtxt, .mdtext');
      input.onchange = (event) => {
        const files = (event?.target as HTMLInputElement).files;
        if (files) {
          readFile(files[0]);
        }
      };
      input.click();
    }
  }

  /**
   * Formats the content using Prettier's Markdown parser.
   */
  public formatContent() {
    this.setContent(
      prettier.format(this.getContent(), {
        parser: 'markdown',
        plugins: [parserMarkdown],
      })
    );
  }

  /***** Developer API *****/

  /**
   * Get the editor's content with the specified line break format.
   * @param lineSeparator The line break format. Default is `\n`.
   */
  public getContent(lineSeparator: string = '\n'): string {
    return this.cm.getValue(lineSeparator);
  }

  /**
   * Get the editor's content with the lines as array.
   */
  public getContentPerLine(): string[] {
    return this.cm.getValue().split('\n');
  }

  /**
   * Set the editor's content with the specified line break format.
   * @param content The content.
   * @param lineSeparator The line break format. Default is `\n`.
   */
  public setContent(content: string, lineSeparator: string = '\n') {
    if (lineSeparator !== '\n') content = content.replace(RegExp(lineSeparator, 'g'), '\n');
    this.cm.setValue(content);
  }

  /**
   * Get the editor's content with the lines as array.
   */
  public setContentPerLine(content: string[]) {
    this.cm.setValue(content.join('\n'));
  }

  /**
   * Get the number of characters in the document.
   */
  public getCharacterCount() {
    return this.cm.getValue().replace(RegExp('\n', 'gi'), '').length;
  }

  /**
   * Get the number of words in the document.
   */
  public getWordCount() {
    const content = this.cm.getValue();
    let s = content.replace(/(^\s*)|(\s*$)/gi, '');
    s = s.replace(/\t/gi, ' ');
    s = s.replace(RegExp('\n', 'gi'), ' ');
    s = s.replace(/[ ]{2,}/gi, ' ');
    return s.split(' ').length;
  }

  /**
   * Get the current cursor position as a `{line, ch}` object.
   * Shortcut for `Codemirror.getCursor()`.
   */
  public getCursorPos() {
    return this.cm.getCursor();
  }

  /**
   * Returns whether the document has been modified.
   * Inverted shortcut for `Codemirror.isClean()`
   */
  public isDirty() {
    return !this.cm.isClean();
  }

  /***** Markdown Editor Options *****/

  /**
   * Overwrites current options with specified options.
   * Options that are not included in specified `options` will not be modified.
   * @param options the set of options that shall be changed
   */
  public setOptions(options: MarkdownEditorOptions) {
    this.options = _.merge(this.options, options);
    this.applyCodemirrorOptions();
    this.applyEditorKeyMappings();
  }

  /**
   * Apply codemirror-specific options that are specified in `this.options`.
   */
  protected applyCodemirrorOptions() {
    this.cm.setOption('autofocus', this.options.autofocus);
    this.cm.setOption('lineWrapping', this.options.lineWrapping);
    this.cm.setOption('placeholder', this.options.placeholder);
    this.cm.setOption('mode', this.options.richTextMode ? 'gfm' : '');
    this.cm.setOption('tabSize', this.options.tabSize);
    this.cm.setOption('theme', this.options.theme);
  }

  /**
   * Apply the key map for markdown editor actions specified in `this.options.shortcuts`
   * to the Codemirror editor instance.
   */
  protected applyEditorKeyMappings() {
    const bindings: { [key in keyof MarkdownEditorShortcuts]: () => any } = {
      toggleBold: () => this.toggleBold(),
      toggleItalic: () => this.toggleItalic(),
      toggleStrikethrough: () => this.toggleStrikethrough(),
      toggleUnorderedList: () => this.toggleUnorderedList(),
      toggleOrderedList: () => this.toggleOrderedList(),
      toggleCheckList: () => this.toggleCheckList(),
      toggleQuote: () => this.toggleQuote(),
      insertLink: () => this.insertLink(),
      insertImageLink: () => this.insertImageLink(),
      insertTable: () => this.insertTable(),
      insertHorizontalLine: () => this.insertHorizontalLine(),
      toggleInlineCode: () => this.toggleInlineCode(),
      insertCodeBlock: () => this.insertCodeBlock(),
      openMarkdownGuide: () => this.openMarkdownGuide(),
      toggleRichTextMode: () => this.toggleRichTextMode(),
      downloadAsFile: () => this.downloadAsFile(),
      importFromFile: () => this.importFromFile(),
      formatContent: () => this.formatContent(),
    };

    const shortcuts = this.options.shortcuts;
    const extraKeys: { [key: string]: () => any } = {};
    for (const [key, value] of Object.entries(shortcuts)) {
      let shortcut: string;
      if (isMac()) {
        shortcut = value.replace('Ctrl', 'Cmd');
      } else {
        shortcut = value.replace('Cmd', 'Ctrl');
      }
      extraKeys[shortcut] = bindings[key as keyof MarkdownEditorShortcuts];
    }

    this.cm.setOption('extraKeys', extraKeys);
  }
}

export class MarkdownEditor extends MarkdownEditorBase {
  constructor(element: HTMLElement, options?: MarkdownEditorOptions) {
    const opts = _.merge(DEFAULT_OPTIONS, options);
    const cm = CodeMirror(element);
    super(cm, opts);
  }

  /**
   * Create a editor instance and replace the specified textarea with it.
   * @param textarea the textarea to be replaced with the editor
   * @param options the editor options
   */
  static fromTextarea(textarea: HTMLTextAreaElement, options?: FromTextareaOptions) {
    return new MarkdownEditorFromTextarea(textarea, options);
  }
}

export class MarkdownEditorFromTextarea extends MarkdownEditorBase {
  public readonly cm: CodeMirror.EditorFromTextArea;
  protected options: FromTextareaOptions;
  protected saver?: (instance: CodeMirror.Editor) => void;

  constructor(textarea: HTMLTextAreaElement, options?: FromTextareaOptions) {
    const opts = _.merge(DEFAULT_FROM_TEXTAREA_OPTIONS, options);
    const cm = CodeMirror.fromTextArea(textarea);
    super(cm, opts);
    this.cm = cm;
    this.options = opts;
  }

  /**
   * Copy the content of the editor into the textarea.
   *
   * Shortcut for `Codemirror.EditorFromTextarea.save()`.
   */
  public save() {
    this.cm.save();
  }

  /**
   * Remove the editor, and restore the original textarea (with the editor's current content).
   *
   * Shortcut for `Codemirror.EditorFromTextarea.toTextarea()`.
   */
  public toTextarea() {
    this.cm.toTextArea();
  }

  /**
   * Returns the textarea that the instance was based on.
   *
   * Shortcut for `Codemirror.EditorFromTextarea.getTextarea()`.
   */
  public getTextarea() {
    this.cm.getTextArea();
  }

  /**
   * @inheritdoc
   */
  public setOptions(options: MarkdownEditorOptions) {
    const opts = _.merge(this.options, options);
    super.setOptions(opts);
    this.options = opts;

    if (this.saver === undefined && this.options.autoSync) {
      this.saver = () => this.save();
      this.cm.on('changes', this.saver);
    } else if (this.saver !== undefined && !this.options.autoSync) {
      this.cm.off('changes', this.saver);
      this.saver = undefined;
    }
  }
}

/***** Util ******/

/**
 * Transform a string so that all Regex-reserved characters are escaped.
 * @param s
 */
function escapeRegexChars(s: string) {
  const reservedChars = ['.', '*', '+', '?', '!', '{', '}', '[', ']'];
  s = s.replace(/\\/gi, '\\\\');
  for (const reservedChar of reservedChars) {
    s = s.replace(RegExp(`\\${reservedChar}`, 'gi'), '\\' + reservedChar);
  }
  return s;
}

function isMac(): boolean {
  return /Mac/.test(navigator.platform);
}

// Extend CodeMirror.EditorConfiguration with options from add ons:
// declare module 'codemirror' {
//   interface EditorConfiguration {
//     // display/placeholder.js
//     placeholder?: string | Element;
//   }
// }