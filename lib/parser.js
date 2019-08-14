"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const debug = require('debug')('sol2uml');
const fs_1 = require("fs");
const path_1 = require("path");
const klaw_1 = __importDefault(require("klaw"));
const solidity_parser_antlr_1 = require("solidity-parser-antlr");
const umlClass_1 = require("./umlClass");
const verror_1 = require("verror");
exports.getSolidityFilesFromFolderOrFiles = (folderOrFilePaths) => {
    let files = [];
    folderOrFilePaths.forEach(folderOrFilePath => {
        exports.getSolidityFilesFromFolderOrFile(folderOrFilePath).then(result => {
            files = files.concat(result);
        });
    });
    return files;
};
exports.getSolidityFilesFromFolderOrFile = (folderOrFilePath) => {
    debug(`About to get Solidity files under ${folderOrFilePath}`);
    return new Promise((resolve, reject) => {
        try {
            const folderOrFile = fs_1.lstatSync(folderOrFilePath);
            if (folderOrFile.isDirectory()) {
                const files = [];
                klaw_1.default(folderOrFilePath)
                    .on('data', file => {
                    if (path_1.extname(file.path) === '.sol')
                        files.push(file.path);
                })
                    .on('end', () => {
                    debug(`Got Solidity files to be parsed: ${files}`);
                    resolve(files);
                });
            }
            else if (folderOrFile.isFile()) {
                if (path_1.extname(folderOrFilePath) === '.sol') {
                    debug(`Got Solidity file to be parsed: ${folderOrFilePath}`);
                    resolve([folderOrFilePath]);
                }
                else {
                    reject(Error(`File ${folderOrFilePath} does not have a .sol extension.`));
                }
            }
            else {
                reject(Error(`Could not find directory or file ${folderOrFilePath}`));
            }
        }
        catch (err) {
            let error;
            if (err && err.code === 'ENOENT') {
                error = Error(`No such file or folder ${folderOrFilePath}. Make sure you pass in the root directory of the contracts`);
            }
            else {
                error = new verror_1.VError(err, `Failed to get Solidity files under folder or file ${folderOrFilePath}`);
            }
            console.error(error.stack);
            reject(error);
        }
    });
};
exports.parseSolidityFile = (fileName) => {
    try {
        const solidityCode = fs_1.readFileSync(fileName, 'utf8');
        const node = solidity_parser_antlr_1.parse(solidityCode, {});
        return parseParentNode(node, fileName);
    }
    catch (err) {
        throw new verror_1.VError(err, `Failed to parse solidity file ${fileName}.`);
    }
};
function parseParentNode(node, fileName) {
    let umlClasses = [];
    if (node.type === "SourceUnit") {
        node.children.forEach(childNode => {
            if (childNode.type === "ContractDefinition") {
                debug(`Adding contract ${childNode.name}`);
                let umlClass = new umlClass_1.UmlClass({
                    name: childNode.name,
                    sourceFile: fileName,
                });
                umlClass = praseContractDefinition(umlClass, childNode);
                umlClasses.push(umlClass);
            }
            else if (childNode.type === "ImportDirective") {
                // TODO travers to parse imports
                // importedContracts.push(contract)
            }
        });
    }
    else {
        throw new Error(`AST node not of type SourceUnit`);
    }
    return umlClasses;
}
function praseContractDefinition(umlClass, node) {
    umlClass.stereotype = parseContractKind(node.kind);
    // For each base contract
    node.baseContracts.forEach(baseClass => {
        // Add a realization association
        umlClass.addAssociation({
            referenceType: umlClass_1.ReferenceType.Storage,
            targetUmlClassName: baseClass.baseName.namePath,
            realization: true,
        });
    });
    // For each sub node
    node.subNodes.forEach(subNode => {
        switch (subNode.type) {
            case "StateVariableDeclaration":
                subNode.variables.forEach((variable) => {
                    umlClass.attributes.push({
                        visibility: parseVisibility(variable.visibility),
                        name: variable.name,
                        type: parseTypeName(variable.typeName),
                    });
                });
                // Recursively parse variables for associations
                umlClass = addAssociations(subNode.variables, umlClass);
                break;
            case "UsingForDeclaration":
                // Add association to library contract
                umlClass.addAssociation({
                    referenceType: umlClass_1.ReferenceType.Memory,
                    targetUmlClassName: subNode.libraryName,
                });
                break;
            case "FunctionDefinition":
                if (subNode.isConstructor) {
                    umlClass.operators.push({
                        name: 'constructor',
                        stereotype: umlClass_1.OperatorStereotype.None,
                        // @ts-ignore
                        parameters: parseParameters(subNode.parameters),
                    });
                }
                // If a fallback function
                else if (subNode.name === "") {
                    umlClass.operators.push({
                        name: '',
                        stereotype: umlClass_1.OperatorStereotype.Fallback,
                        // @ts-ignore
                        parameters: parseParameters(subNode.parameters),
                        isPayable: parsePayable(subNode.stateMutability),
                    });
                }
                else {
                    let stereotype = umlClass_1.OperatorStereotype.None;
                    if (subNode.body === null) {
                        stereotype = umlClass_1.OperatorStereotype.Abstract;
                    }
                    else if (subNode.stateMutability === 'payable') {
                        stereotype = umlClass_1.OperatorStereotype.Payable;
                    }
                    umlClass.operators.push({
                        visibility: parseVisibility(subNode.visibility),
                        name: subNode.name,
                        stereotype,
                        // @ts-ignore
                        parameters: parseParameters(subNode.parameters),
                        returnParameters: parseParameters(subNode.returnParameters),
                    });
                }
                // Recursively parse function parameters for associations
                umlClass = addAssociations(subNode.parameters.parameters, umlClass);
                if (subNode.returnParameters) {
                    umlClass = addAssociations(subNode.returnParameters.parameters, umlClass);
                }
                // If no body to the function, it must be either an Interface or Abstract
                if (subNode.body === null) {
                    if (umlClass.stereotype !== umlClass_1.ClassStereotype.Interface) {
                        // If not Interface, it must be Abstract
                        umlClass.stereotype = umlClass_1.ClassStereotype.Abstract;
                    }
                }
                else {
                    // Recursively parse function statements for associations
                    umlClass = addAssociations(subNode.body.statements, umlClass);
                }
                break;
            case "ModifierDefinition":
                umlClass.operators.push({
                    stereotype: umlClass_1.OperatorStereotype.Modifier,
                    name: subNode.name,
                    // @ts-ignore ModifierDefinition type missing parameters
                    parameters: parseParameters(subNode.parameters),
                });
                break;
            case "EventDefinition":
                umlClass.operators.push({
                    stereotype: umlClass_1.OperatorStereotype.Event,
                    name: subNode.name,
                    // @ts-ignore
                    parameters: parseParameters(subNode.parameters),
                });
                // Recursively parse event parameters for associations
                umlClass = addAssociations(subNode.parameters.parameters, umlClass);
                break;
            case "StructDefinition":
                let structMembers = [];
                subNode.members.forEach((member) => {
                    structMembers.push({
                        name: member.name,
                        type: parseTypeName(member.typeName),
                    });
                });
                umlClass.structs[subNode.name] = structMembers;
                // Recursively parse members for associations
                umlClass = addAssociations(subNode.members, umlClass);
                break;
            case 'EnumDefinition':
                let enumValues = [];
                subNode.members.forEach((member) => {
                    enumValues.push(member.name);
                });
                umlClass.enums[subNode.name] = enumValues;
                break;
        }
    });
    return umlClass;
}
// Recursively parse AST nodes for associations
function addAssociations(nodes, umlClass) {
    if (!nodes || !Array.isArray(nodes)) {
        debug('Warning - can not recursively parse AST nodes for associations. Invalid nodes array');
        return umlClass;
    }
    for (const node of nodes) {
        // Some variables can be null. eg var (lad,,,) = tub.cups(cup);
        if (node === null) {
            break;
        }
        // Recursively parse sub nodes that can has variable declarations
        switch (node.type) {
            case 'VariableDeclaration':
            case 'Parameter':
                if (!node.typeName) {
                    break;
                }
                if (node.typeName.type === 'UserDefinedTypeName') {
                    // If state variable then mark as a Storage reference, else Memory
                    const referenceType = (node.isStateVar) ? umlClass_1.ReferenceType.Storage : umlClass_1.ReferenceType.Memory;
                    // Library references can have a Library dot variable notation. eg Set.Data
                    const targetUmlClassName = parseClassName(node.typeName.namePath);
                    umlClass.addAssociation({
                        referenceType,
                        targetUmlClassName,
                    });
                }
                else if (node.typeName.type === 'Mapping') {
                    umlClass = addAssociations([node.typeName.keyType], umlClass);
                    umlClass = addAssociations([node.typeName.valueType], umlClass);
                }
                break;
            case 'UserDefinedTypeName':
                umlClass.addAssociation({
                    referenceType: umlClass_1.ReferenceType.Memory,
                    targetUmlClassName: node.namePath,
                });
                break;
            case 'Block':
                umlClass = addAssociations(node.statements, umlClass);
                break;
            case 'StateVariableDeclaration':
            case 'VariableDeclarationStatement':
                umlClass = addAssociations(node.variables, umlClass);
                break;
            case 'ForStatement':
            case 'WhileStatement':
            case 'DoWhileStatement':
                // @ts-ignore type of body is a Block and not a Statement
                umlClass = addAssociations(node.body.statements, umlClass);
                break;
            case 'IfStatement':
                // @ts-ignore type Statement can be a Block
                if (node.trueBody && node.trueBody.statements) {
                    // @ts-ignore
                    umlClass = addAssociations(node.trueBody.statements, umlClass);
                }
                // @ts-ignore type Statement can be a Block
                if (node.falseBody && node.falseBody.statements) {
                    // @ts-ignore
                    umlClass = addAssociations(node.falseBody.statements, umlClass);
                }
                break;
            default:
                break;
        }
    }
    return umlClass;
}
function parseClassName(rawClassName) {
    if (!rawClassName || typeof rawClassName !== 'string' || rawClassName.length === 0) {
        return '';
    }
    // Split the name on dot
    const splitUmlClassName = rawClassName.split('.');
    const umlClassName = splitUmlClassName[0];
    return umlClassName;
}
function parseVisibility(visibility) {
    switch (visibility) {
        case 'default':
            return umlClass_1.Visibility.Public;
        case 'public':
            return umlClass_1.Visibility.Public;
        case 'external':
            return umlClass_1.Visibility.External;
        case 'internal':
            return umlClass_1.Visibility.Internal;
        case 'private':
            return umlClass_1.Visibility.Private;
        default:
            throw Error(`Invalid visibility ${visibility}. Was not public, external, internal or private`);
    }
}
function parseTypeName(typeName) {
    switch (typeName.type) {
        case 'ElementaryTypeName':
            return typeName.name;
        case 'UserDefinedTypeName':
            return typeName.namePath;
        case 'FunctionTypeName':
            // TODO add params and return type
            return typeName.type + '\\(\\)';
        case 'ArrayTypeName':
            return parseTypeName(typeName.baseTypeName) + '[]';
        case 'Mapping':
            return 'mapping\\(' + typeName.keyType.name + '=\\>' + parseTypeName(typeName.valueType) + '\\)';
        default:
            throw Error(`Invalid typeName ${typeName}`);
    }
}
function parseParameters(params) {
    if (!params || !params.parameters) {
        return [];
    }
    let parameters = [];
    for (const param of params.parameters) {
        parameters.push({
            name: param.name,
            type: parseTypeName(param.typeName),
        });
    }
    return parameters;
}
function parseContractKind(kind) {
    switch (kind) {
        case 'contract':
            return umlClass_1.ClassStereotype.None;
        case 'interface':
            return umlClass_1.ClassStereotype.Interface;
        case 'library':
            return umlClass_1.ClassStereotype.Library;
        default:
            throw Error(`Invalid kind ${kind}`);
    }
}
function parsePayable(stateMutability) {
    return stateMutability === 'payable';
}
//# sourceMappingURL=parser.js.map