/// <reference path="types.ts"/>
/// <reference path="factory.ts"/>
module ts {

    enum BlockAction {
        Open,
        Close,
    }

    enum BlockKind {
        Exception,
        ScriptBreak,
        Break,
        ScriptContinue,
        Continue
    }

    enum ExceptionBlockState {
        Try,
        Catch,
        Finally,
        Done
    }

    interface BlockScope {
        kind: BlockKind;
    }

    interface ExceptionBlock extends BlockScope {
        state: ExceptionBlockState;
        startLabel: Label;
        catchVariable?: Identifier;
        catchLabel?: Label;
        finallyLabel?: Label;
        endLabel: Label;
    }

    interface BreakBlock extends BlockScope {
        breakLabel: Label;
        labelText?: string;
    }

    interface ContinueBlock extends BreakBlock {
        continueLabel: Label;
    }

    export function createCodeGenerator(): CodeGenerator {
        // locations
        var relatedLocation: TextRange;
        var locationStack: TextRange[] = [];

        // locals/hoisted variables/hoisted functions
        var nextLocalId: number = 0;
        var parameters: ParameterDeclaration[] = [];
        var locals: GeneratedNode[] = [];
        var namedLocals: GeneratedNode[] = [];
        var functions: FunctionDeclaration[] = [];

        // blocks
        var blocks: BlockScope[] = [];
        var blockStack: BlockScope[] = [];
        var blockActions: BlockAction[] = [];
        var blockOffsets: number[] = [];
        var hasProtectedRegions: boolean = false;

        // labels
        var nextLabelId: number = 1;
        var labelNumbers: number[] = [];
        var labels: number[] = [];

        // operations
        var operations: OpCode[] = [];
        var operationArguments: any[][] = [];
        var operationLocations: TextRange[] = [];

        // mark the entry point
        markLabel(defineLabel());

        return {
            addFunction,
            addParameter,
            declareLocal,
            defineLabel,
            markLabel,
            beginExceptionBlock,
            beginCatchBlock,
            beginFinallyBlock,
            endExceptionBlock,
            findBreakTarget,
            findContinueTarget,
            beginScriptContinueBlock,
            endScriptContinueBlock,
            beginScriptBreakBlock,
            endScriptBreakBlock,
            beginContinueBlock,
            endContinueBlock,
            beginBreakBlock,
            endBreakBlock,
            emit,
            emitNode,
            pushLocation,
            popLocation,
            setLocation,
            cacheExpression,
            createInlineBreak,
            createInlineReturn,
            createGeneratedNode,
            buildGeneratorFunction,
            buildAsyncFunction
        };

        function addParameter(name: Identifier, flags?: NodeFlags): void {
            parameters.push(factory.createParameterDeclaration(name, undefined, relatedLocation, flags));
        }

        function addFunction(func: FunctionDeclaration): void {
            functions[functions.length] = func;
        }

        function declareLocal(name?: string): GeneratedNode {
            if (name) {
                var list = namedLocals;
            } else {
                name = "__l" + (nextLocalId++)
                var list = locals;
            }

            var localDeclarationName = createGeneratedNode(name);
            list.push(localDeclarationName);
            return localDeclarationName;
        }

        function defineLabel(): Label {
            var label = nextLabelId++;
            labels[label] = -1;
            return <Label>label;
        }

        function markLabel(label: Label): void {
            labels[<number>label] = operations.length;
        }

        function beginExceptionBlock(): Label {
            var startLabel = defineLabel();
            var endLabel = defineLabel();
            markLabel(startLabel);
            beginBlock<ExceptionBlock>({
                kind: BlockKind.Exception,
                state: ExceptionBlockState.Try,
                startLabel,
                endLabel,
            });
            hasProtectedRegions = true;
            return endLabel;
        }

        function beginCatchBlock(variable: Identifier): void {
            Debug.assert(peekBlockKind() === BlockKind.Exception);

            var exception = <ExceptionBlock>peekBlock();
            Debug.assert(exception.state < ExceptionBlockState.Catch);

            var endLabel = exception.endLabel;
            emit(OpCode.Break, endLabel);

            var catchLabel = defineLabel();
            markLabel(catchLabel);
            exception.state = ExceptionBlockState.Catch;
            exception.catchVariable = variable;
            exception.catchLabel = catchLabel;

            emit(OpCode.Statement, `\${variable} = __state.error;`, { variable });
        }

        function beginFinallyBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.Exception);

            var exception = <ExceptionBlock>peekBlock();
            Debug.assert(exception.state < ExceptionBlockState.Finally);

            var state = exception.state;
            var endLabel = exception.endLabel;
            emit(OpCode.Break, endLabel);

            var finallyLabel = defineLabel();
            markLabel(finallyLabel);
            exception.state = ExceptionBlockState.Finally;
            exception.finallyLabel = finallyLabel;
        }

        function endExceptionBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.Exception);
            var exception = endBlock<ExceptionBlock>();
            var state = exception.state;
            if (state < ExceptionBlockState.Finally) {
                emit(OpCode.Break, exception.endLabel);
            }
            else {
                emit(OpCode.Endfinally);
            }

            markLabel(exception.endLabel);
            exception.state = ExceptionBlockState.Done;
        }

        function beginScriptContinueBlock(labelText: string): void {
            beginBlock<ContinueBlock>({
                kind: BlockKind.ScriptContinue,
                labelText: labelText,
                breakLabel: -1,
                continueLabel: -1
            });
        }

        function endScriptContinueBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.ScriptContinue);
            endBlock<ContinueBlock>();
        }

        function beginScriptBreakBlock(labelText: string): void {
            beginBlock<BreakBlock>({
                kind: BlockKind.ScriptBreak,
                labelSymbol: labelText,
                breakLabel: -1
            });
        }

        function endScriptBreakBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.ScriptBreak);
            endBlock<BreakBlock>();
        }

        function beginContinueBlock(continueLabel: Label, labelText: string): Label {
            var breakLabel = defineLabel();
            beginBlock<ContinueBlock>({
                kind: BlockKind.Continue,
                labelText: labelText,
                breakLabel: breakLabel,
                continueLabel: continueLabel
            });
            return breakLabel;
        }

        function endContinueBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.Continue);
            var block = endBlock<BreakBlock>();
            var breakLabel = block.breakLabel;
            if (breakLabel > 0) {
                markLabel(breakLabel);
            }
        }

        function beginBreakBlock(labelText: string): Label {
            var breakLabel = defineLabel();
            beginBlock<BreakBlock>({
                kind: BlockKind.Break,
                labelText: labelText,
                breakLabel: breakLabel
            });
            return breakLabel;
        }

        function endBreakBlock(): void {
            Debug.assert(peekBlockKind() === BlockKind.Break);
            var block = endBlock<BreakBlock>();
            var breakLabel = block.breakLabel;
            if (breakLabel > 0) {
                markLabel(breakLabel);
            }
        }

        function beginBlock<TBlock extends BlockScope>(block: TBlock): number {
            var index = blockActions.length;
            blockActions[index] = BlockAction.Open;
            blockOffsets[index] = operations.length;
            blocks[index] = block;
            blockStack.push(block);
            return index;
        }

        function endBlock<TBlock extends BlockScope>(): TBlock {
            var block = blockStack.pop();
            var index = blockActions.length;
            blockActions[index] = BlockAction.Close;
            blockOffsets[index] = operations.length;
            blocks[index] = block;
            return <TBlock>block;
        }

        function peekBlock(back: number = 0): BlockScope {
            return blockStack[blockStack.length - (1 + back)];
        }

        function peekBlockKind(back: number = 0): BlockKind {
            var block = peekBlock(back);
            return block && block.kind;
        }

        function findBreakTarget(labelText?: string): Label {
            for (var i = blockStack.length - 1; i >= 0; i--) {
                var block = blockStack[i];
                if (supportsBreak(block)) {
                    var breakBlock = <BreakBlock>block;
                    if (!labelText || breakBlock.labelText === labelText) {
                        return breakBlock.breakLabel;
                    }
                }
            }

            return 0;
        }

        function findContinueTarget(labelText?: string): Label {
            for (var i = blockStack.length - 1; i >= 0; i--) {
                var block = blockStack[i];
                if (supportsContinue(block)) {
                    var continueBreakBlock = <ContinueBlock>block;
                    if (!labelText || continueBreakBlock.labelText === labelText) {
                        return continueBreakBlock.continueLabel;
                    }
                }
            }
        }

        function supportsBreak(block: BlockScope): boolean {
            switch (block.kind) {
                case BlockKind.ScriptBreak:
                case BlockKind.ScriptContinue:
                case BlockKind.Break:
                case BlockKind.Continue:
                    return true;
            }
            return false;
        }

        function supportsContinue(block: BlockScope): boolean {
            switch (block.kind) {
                case BlockKind.ScriptContinue:
                case BlockKind.Continue:
                    return true;
            }
            return false;
        }

        function emit(code: OpCode, ...args: any[]): void {
            if (typeof args[0] === "string") {
                args = [createGeneratedNode(args[0], args[1])];
            } else if (typeof args[1] === "string") {
                args = [args[0], createGeneratedNode(args[1], args[2])];
            }

            if (code === OpCode.Statement) {
                var node = args[0];
                if (!node) {
                    return;
                }
            }

            var operationIndex = operations.length;
            operations[operationIndex] = code;
            operationArguments[operationIndex] = args;
            operationLocations[operationIndex] = relatedLocation;
        }

        function emitNode(node: Node): void {
            switch (node.kind) {
                case SyntaxKind.Block:
                case SyntaxKind.FunctionBlock:
                case SyntaxKind.TryBlock:
                case SyntaxKind.CatchBlock:
                case SyntaxKind.FinallyBlock:
                    return forEach((<Block>node).statements, emitNode);

                case SyntaxKind.CaseClause:
                case SyntaxKind.DefaultClause:
                    return forEach((<CaseOrDefaultClause>node).statements, emitNode);
            }

            emit(OpCode.Statement, node);
        }

        function pushLocation(location: TextRange): void {
            locationStack.push(relatedLocation);
            setLocation(location);
        }

        function popLocation(): void {
            setLocation(locationStack.pop());
        }

        function setLocation(location: TextRange): void {
            if (location) {
                relatedLocation = location;
            }
        }

        function cacheExpression(node: Expression): GeneratedNode {
            var local = declareLocal();
            emit(OpCode.Statement, createGeneratedNode(`\${local} = \${node};`, { local, node }));
            return local;
        }

        function createLabel(label: Label): GeneratedLabel {
            return factory.createGeneratedLabel(label, labelNumbers, relatedLocation);
        }

        function createGeneratedNode(text: string, content?: Map<Node|Node[]>): GeneratedNode {
            return factory.createGeneratedNode(text, content, relatedLocation);
        }

        function createInlineBreak(label: Label): Statement {
            return createGeneratedNode(`return ["break", \${label}];`, { label: createLabel(label) });
        }

        function createInlineReturn(expression: Expression): Statement {
            if (expression) {
                return createGeneratedNode(`return ["return", \${expression}];`, { expression });
            } else {
                return createGeneratedNode(`return ["return"];`);
            }
        }

        function createYield(expression: Expression): Statement {
            if (expression) {
                return createGeneratedNode(`return ["yield", \${expression}];`, { expression });
            } else {
                return createGeneratedNode(`return ["yield"];`);
            }
        }

        function buildGeneratorFunction(kind: SyntaxKind, name: DeclarationName, location: TextRange) {
            pushLocation(location);
            var body = createGeneratedNode(`
                \${locals}
                @{functions}
                return __generator(function (__state) {
                    switch (__state.label) {
                        @{body}
                    }
                });`, { locals: buildLocals(), functions, body: buildFunctionBody() });
            var node = buildFunction(kind, name, body, location);
            popLocation();
            return node;
        }

        function buildAsyncFunction(kind: SyntaxKind, name: DeclarationName, promiseConstructor: EntityName, location: TextRange) {
            pushLocation(location);
            var body = createGeneratedNode(`
                \${locals}
                @{functions}
                return new \${promise}(function (__resolve) {
                    __resolve(__awaiter(__generator(function (__state) {
                        switch (__state.label) {
                            @{body}
                        }
                    })));
                });`, { locals: buildLocals(), functions, promise: promiseConstructor, body: buildFunctionBody() });
            var node = buildFunction(kind, name, body, location);
            popLocation();
            return node;
        }

        function buildFunction(kind: SyntaxKind, name: DeclarationName, body: GeneratedNode, location: TextRange) {
            var block = factory.createFunctionBlock([body], relatedLocation);
            var node: FunctionLikeDeclaration;
            switch (kind) {
                case SyntaxKind.FunctionDeclaration:
                    node = factory.createFunctionDeclaration(<Identifier>name, block, parameters, location);
                    break;

                case SyntaxKind.Method:
                    node = factory.createMethodDeclaration(name, block, parameters, location);
                    break;

                case SyntaxKind.GetAccessor:
                    node = factory.createGetAccessor(name, block, parameters, location);
                    break;

                case SyntaxKind.FunctionExpression:
                    node = factory.createFunctionExpression(<Identifier>name, block, parameters, location);
                    break;

                case SyntaxKind.ArrowFunction:
                    node = factory.createArrowFunction(block, parameters, location);
                    break;
            }
            return node;
        }

        function buildLocals(): GeneratedNode {
            if (namedLocals.length || locals.length) {
                return createGeneratedNode(`var \${locals};`, {
                    locals: namedLocals.concat(locals)
                });
            }
        }

        function buildFunctionBody(): GeneratedNode[] {
            var exceptionStack: ExceptionBlock[] = [];
            var clauses: GeneratedNode[] = [];
            var statements: Statement[] = [];
            var statementsStack: NodeArray<Statement>[] = [];
            var blockIndex: number = 0;
            var instructionWasAbrupt = false;
            var instructionWasCompletion = false;

            for (var operationIndex = 0; operationIndex < operations.length; operationIndex++) {
                var code = operations[operationIndex];
                var args = operationArguments[operationIndex];
                relatedLocation = operationLocations[operationIndex];
                ensureLabels();
                writeOperation(code, args);
            }

            ensureLabels();
            if (!instructionWasCompletion) {
                writeReturn();
            }

            return clauses;

            function ensureLabels(): void {
                var createCase = false;
                for (var label = 0; label < labels.length; label++) {
                    if (labels[label] === operationIndex) {
                        labelNumbers[label] = clauses.length;
                        createCase = true;
                    }
                }

                if (createCase) {
                    var labelNumber = clauses.length;
                    var labelExpression = createGeneratedNode(String(labelNumber));

                    // handle implicit fall-through
                    if (!instructionWasAbrupt && !instructionWasCompletion && operationIndex > 0) {
                        writeStatement(createGeneratedNode(`__state.label = \${label};`, { label: createGeneratedNode(String(labelNumber)) }));
                    }

                    statements = [];
                    instructionWasAbrupt = false;
                    instructionWasCompletion = false;

                    clauses.push(createGeneratedNode(`
                        case \${label}:
                            @{statements}`, { 
                            label: labelExpression,
                            statements
                    }));

                    if (labelNumber === 0 && hasProtectedRegions) {
                        writeStatement(createGeneratedNode(`__state.trys = [];`));
                    }
                }
            }

            function writeOperation(code: OpCode, args: any[]): void {
                for (; blockIndex < blockActions.length && blockOffsets[blockIndex] <= operationIndex; blockIndex++) {
                    var block = blocks[blockIndex];
                    if (blockActions[blockIndex] === BlockAction.Open && block.kind === BlockKind.Exception) {
                        var exception = <ExceptionBlock>block;
                        writeStatement(createGeneratedNode(`__state.trys.push([\${startLabel},\${catchLabel},\${finallyLabel},\${endLabel}])`, {
                            startLabel: createLabel(exception.startLabel),
                            catchLabel: exception.catchLabel > 0 && createLabel(exception.catchLabel),
                            finallyLabel: exception.finallyLabel > 0 && createLabel(exception.finallyLabel),
                            endLabel: createLabel(exception.endLabel)
                        }));
                    }
                }

                // early termination, nothing else to process in this label
                if (instructionWasAbrupt || instructionWasCompletion) {
                    return;
                }

                instructionWasAbrupt = false;
                instructionWasCompletion = false;
                switch (code) {
                    case OpCode.Statement: return writeStatement(<Node>args[0]);
                    case OpCode.Assign: return writeAssign(<Expression>args[0], <Expression>args[1]);
                    case OpCode.Break: return writeBreak(<Label>args[0]);
                    case OpCode.BrTrue: return writeBrTrue(<Label>args[0], <Expression>args[1]);
                    case OpCode.BrFalse: return writeBrFalse(<Label>args[0], <Expression>args[1]);
                    case OpCode.Yield: return writeYield(<Expression>args[0]);
                    case OpCode.Return: return writeReturn(<Expression>args[0]);
                    case OpCode.Throw: return writeThrow(<Expression>args[0]);
                    case OpCode.Endfinally: return writeEndfinally();
                }
            }

            function writeStatement(node: Node): void {
                if (!isStatement(node) && node.kind !== SyntaxKind.GeneratedNode) {
                    node = factory.createExpressionStatement(node, relatedLocation);
                }

                if (!node.parent) {
                    node.parent = clauses[clauses.length - 1];
                }

                statements.push(<Statement>node);
            }

            function writeAssign(left: Expression, right: Expression): void {
                writeStatement(createGeneratedNode(`\${left} = \${right}`, { left, right }));
            }

            function writeBreak(label: Label): void {
                instructionWasAbrupt = true;
                writeStatement(createInlineBreak(label));
            }

            function writeBrTrue(label: Label, condition: Expression): void {
                var statement = createInlineBreak(label);
                writeStatement(createGeneratedNode(`if (\${condition}) { \${statement} }`, { condition, statement }));
            }

            function writeBrFalse(label: Label, condition: Expression): void {
                var statement = createInlineBreak(label);
                writeStatement(createGeneratedNode(`if (!(\${condition})) { \${statement} }`, { condition, statement }));
            }

            function writeYield(expression: Expression): void {
                instructionWasAbrupt = true;
                writeStatement(createYield(expression));
            }

            function writeReturn(expression?: Expression): void {
                instructionWasCompletion = true;
                writeStatement(createInlineReturn(expression));
            }

            function writeThrow(expression: Expression): void {
                instructionWasCompletion = true;
                writeStatement(createGeneratedNode(`throw \${expression};`, { expression }));
            }

            function writeEndfinally(): void {
                instructionWasAbrupt = true;
                writeStatement(createGeneratedNode(`return ["endfinally"];`));
            }
        }
    }
}
