import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAI } from 'openai';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "text-compare" is now active!');

    let reviseCommand = vscode.commands.registerCommand('gptrevise.revise', async () => {
        await generateAndCompare('revise.prompt');
    });

    let grammarCommand = vscode.commands.registerCommand('gptrevise.grammar', async () => {
        await generateAndCompare('grammar.prompt');
    });

    context.subscriptions.push(reviseCommand);
    context.subscriptions.push(grammarCommand);
}

export function deactivate() {}

async function generateAndCompare(promptFileName: string) {
    const selectedText = getSelectedText();
    if (!selectedText) {
        vscode.window.showInformationMessage('No text is selected.');
        return;
    }

    const config = vscode.workspace.getConfiguration('gptrevise');
    const apiUrl = config.get<string>('apiUrl');
    const apiKey = config.get<string>('apiKey');
    const model = config.get<string>('model');

    if (!apiUrl || !apiKey || !model) {
        vscode.window.showErrorMessage('Please configure the API URL, API Key, and model in the settings.');
        return;
    }

    const openai = new OpenAI({
        apiKey: apiKey,
        baseURL: apiUrl,
    });

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Workspace not found.');
        return;
    }

    const compareFolderPath = path.join(workspaceFolder, '.compare');
    ensureCompareFolderExists(compareFolderPath);

    const default_revise_prompt = 'Please polish the following text to improve clarity, grammar, and flow while maintaining the original meaning. Ensure the output language matches the input language exactly. Return only the revised text without any additional explanations or notes.';
    const default_grammar_prompt = 'Please perform a grammar check on the following text and return the revised text. Ensure the output language matches the input language, and only provide the corrected text without any explanations, greetings, or annotations.';
    const prompt = readFileContent(path.join(compareFolderPath, promptFileName)) || 
               (promptFileName === 'revise.prompt' ? default_revise_prompt : 
               (promptFileName === 'grammar.prompt' ? default_grammar_prompt : ''));

    if (!prompt) {
        vscode.window.showErrorMessage(`Unable to read ${promptFileName} file.`);
        return;
    }

    const originFile = createTempFile(selectedText, compareFolderPath, 'origin.txt');
    const revisedFile = createTempFile('', compareFolderPath, 'revised.txt');

    await vscode.commands.executeCommand('vscode.diff', originFile, revisedFile, 'Compare Files');

    await callOpenAiApiAndUpdateFile(openai, model, prompt, selectedText, originFile, revisedFile);
}

function getSelectedText(): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const selection = editor.selection;
        return editor.document.getText(selection);
    }
    return '';
}

function ensureCompareFolderExists(compareFolderPath: string): void {
    if (!fs.existsSync(compareFolderPath)) {
        fs.mkdirSync(compareFolderPath);
    }
}

function createTempFile(content: string, folderPath: string, fileName: string): vscode.Uri {
    const filePath = path.join(folderPath, fileName);
    fs.writeFileSync(filePath, content);
    return vscode.Uri.file(filePath);
}

function readFileContent(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.error('Error reading file:', filePath);
        return null;
    }
}

async function callOpenAiApiAndUpdateFile(
    openai: OpenAI,
    model: string,
    prompt: string,
    selectedText: string,
    originFile: vscode.Uri,
    revisedFile: vscode.Uri
) {
    try {
        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: prompt },
            { role: 'user', content: selectedText }
        ];

        const stream = await openai.chat.completions.create({
            model: model,
            messages: messages,
            stream: true,
        });

        const document = await vscode.workspace.openTextDocument(revisedFile);

        const diffEditor = await vscode.commands.executeCommand(
            'vscode.diff',
            originFile,
            revisedFile,
            'Compare Files'
        );

        let processedText = '';
        for await (const chunk of stream) {
            const chunkContent = chunk.choices[0]?.delta?.content || '';
            processedText += chunkContent;

            const fullText = processedText;
            const lastLine = document.lineAt(document.lineCount - 1);
            const range = new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);

            const edit = new vscode.WorkspaceEdit();
            edit.replace(revisedFile, range, fullText);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }
    } catch (error) {
        console.error("Error:", error);
        vscode.window.showErrorMessage('An error occurred while calling the GPT API.');
    }
}