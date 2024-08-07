import { Diagnostic, CodeActionKind, CodeAction, WorkspaceEdit } from 'vscode-languageserver/node';
import {
	TextDocument,
	TextEdit
} from 'vscode-languageserver-textdocument';
import { NonterminalKind, TerminalKind } from "@nomicfoundation/slang/kinds";
import { Namespace, Variable, printNamespaceTemplate, getNamespaceId, printPublicGetter, toStorageStructName } from './namespace';
import { Language } from '@nomicfoundation/slang/language';
import assert = require('node:assert');
import { NonterminalNode, TerminalNode } from '@nomicfoundation/slang/cst';
import { ContractDefinition } from '@nomicfoundation/slang/ast';
import { cursor, text_index } from '@nomicfoundation/slang';
import { slangToVSCodeRange } from './helpers/slang';
import { inferSolidityVersion } from './solidityVersion';
import { workspaceFolders } from './server';

/**
 * Gets a quick fix for moving all variables into a namespace.
 */
export async function getMoveAllVariablesToNamespaceQuickFix(fixesDiagnostics: Diagnostic[], title: string, prefix: string, contractName: string, variables: Variable[], textDocument: TextDocument): Promise<CodeAction | undefined> {
	let namespaceStructEndRange: text_index.TextRange | undefined = undefined;

	const language = new Language(await inferSolidityVersion(textDocument, workspaceFolders));
	const parseOutput = language.parse(NonterminalKind.SourceUnit, textDocument.getText());

	const cursor = parseOutput.createTreeCursor();

	let contractCursor;

	const edits: TextEdit[] = [];

	while (cursor.goToNextNonterminalWithKind(NonterminalKind.ContractDefinition)) {
		contractCursor = cursor.spawn();

		const cursorNode = contractCursor.node();
		assert(cursorNode instanceof NonterminalNode);
		const contractDef = new ContractDefinition(cursorNode);

		const parseContract = language.parse(NonterminalKind.ContractDefinition, cursorNode.unparse());
		if (!parseContract.isValid) {
			console.log("Contract has errors");
			continue;
		} else {
			console.log("Parsing contract: " + contractDef.name.text);
		}

		if (contractDef.name.text !== contractName) {
			// skip if its not the contract we are looking for
			continue;
		} else {
			namespaceStructEndRange = getNamespaceStructEndRange(contractCursor, prefix, contractName);
			editNamespaceVariablesInFunctions(contractCursor, contractName, variables, textDocument, edits);

			// only process the first contract that matches the contractName
			break;
		}
	}

	if (variables.length === 0) {
		return undefined;
	}

	if (namespaceStructEndRange === undefined) {
		editNewNamespace(edits);
	} else {
		editExistingNamespace(edits, namespaceStructEndRange);
	}

	let workspaceEdit: WorkspaceEdit = {
		changes: { [textDocument.uri]: [...edits] }
	};
	let codeAction: CodeAction = {
		title: title,
		kind: CodeActionKind.QuickFix,
		edit: workspaceEdit,
		diagnostics: fixesDiagnostics,
	};

	return codeAction;

	function editNewNamespace(edits: TextEdit[]) {
		const namespace: Namespace = {
			contractName,
			prefix,
			variables,
		};

		// for a new namespace, replace the first variable with the namespace (including public getter functions), then delete the rest of the variables
		let insertVariableTextEdit: TextEdit = {
			range: variables[0].range,
			newText: printNamespaceTemplate(namespace),
		};
		edits.push(insertVariableTextEdit);

		for (const variable of variables.slice(1)) {
			let deleteVariableTextEdit: TextEdit = {
				range: variable.range,
				newText: ""
			};
			edits.push(deleteVariableTextEdit);
		}
	}

	function editExistingNamespace(edits: TextEdit[], structEndRange: text_index.TextRange, indent = "    ") {
		// for an existing namespace, remove all variables and insert them into the end of the struct
		for (const variable of variables) {
			if (variable.publicGetter) {
				// if the variable has a public getter, replace the variable with the public getter
				const publicGetterTextEdit: TextEdit = {
					range: variable.range,
					newText: printPublicGetter(variable.name, variable.publicGetter.typeName, toStorageStructName(contractName), indent)
				};
				edits.push(publicGetterTextEdit);
			} else {
				// otherwise, just delete the variable
				const deleteVariableTextEdit: TextEdit = {
					range: variable.range,
					newText: ""
				};
				edits.push(deleteVariableTextEdit);	
			}

			// TODO infer indents from textDocument using the first indent before the first non-trivia in the contract
			// TODO instead of adding indents, get the trivia around the original variable and use that
			const insertVariableTextEdit: TextEdit = {
				range: slangToVSCodeRange(textDocument, structEndRange),
				newText: `\
${indent}${variable.content}
${indent}}\
`
			};
			edits.push(insertVariableTextEdit);
		}
	}
}

function getNamespaceStructEndRange(contractCursor: cursor.Cursor, prefix: string, contractName: string): text_index.TextRange | undefined {
	const namespaceStructCursor = contractCursor.spawn();
	namespaceStructCursor.goToNextTerminalWithKind(TerminalKind.SingleLineNatSpecComment);
	const natspecNode = namespaceStructCursor.node();
	if (natspecNode instanceof TerminalNode) {
		const natspecText = natspecNode.text;

		if (natspecText.includes(`@custom:storage-location erc7201:${getNamespaceId(prefix, contractName)}`)) {
			// get range of the end of the struct
			const namespaceStructEndCursor = contractCursor.spawn();
			namespaceStructEndCursor.goToNextTerminalWithKind(TerminalKind.CloseBrace);
			return namespaceStructEndCursor.textRange;
		}
	}
	return undefined;
}

function editNamespaceVariablesInFunctions(contractCursor: cursor.Cursor, contractName: string, variables: Variable[], textDocument: TextDocument, edits: TextEdit[]) {
	const cursor = contractCursor.spawn();
	while (cursor.goToNextNonterminalWithKinds([NonterminalKind.ConstructorDefinition, NonterminalKind.FunctionBody])) {
		const blockCursor = cursor.spawn();
		blockCursor.goToNextNonterminalWithKind(NonterminalKind.Block);

		const blockNode = blockCursor.node();
		assert(blockNode instanceof NonterminalNode);

		const needsReplacement = replaceVariables(blockCursor, variables, edits, textDocument);
		if (needsReplacement) {
			addStorageGetter(contractName, blockNode, blockCursor, edits, textDocument);
		}
	}
}

function addStorageGetter(contractName: string, blockNode: NonterminalNode, functionBodyCursor: cursor.Cursor, edits: TextEdit[], textDocument: TextDocument, indent = "    ") {
	const expectedLine = `${toStorageStructName(contractName)} storage $ = _get${toStorageStructName(contractName)}();`
	if (!blockNode.unparse().includes(expectedLine)) {
		const openBraceCursor = functionBodyCursor.spawn();
		assert(openBraceCursor.goToNextTerminalWithKind(TerminalKind.OpenBrace));
		edits.push({
			range: slangToVSCodeRange(textDocument, openBraceCursor.textRange),
			newText: `{\n${indent}${indent}${expectedLine}\n`
		});
	}
}

function replaceVariables(blockCursor: cursor.Cursor, variables: Variable[], edits: TextEdit[], textDocument: TextDocument): boolean {
	let needsReplacement = false;
	const identifierCursor = blockCursor.spawn();
	while (identifierCursor.goToNextTerminalWithKind(TerminalKind.Identifier)) {
		const identifierNode = identifierCursor.node();
		assert(identifierNode instanceof TerminalNode);

		if (variables.some(variable => variable.name === identifierNode.text)) {
			needsReplacement = true;
			edits.push({
				range: slangToVSCodeRange(textDocument, identifierCursor.textRange),
				newText: `$.${identifierNode.text}`
			});
		}
	}
	return needsReplacement;
}
