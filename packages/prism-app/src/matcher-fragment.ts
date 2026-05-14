import { createHash } from "node:crypto";
import {
  parseMatcherQuery,
  type CompareOp,
  type FieldName,
  type FieldPredicate,
  type GraphPredicate,
  type HierarchyPredicate,
  type QueryNode,
  type TimeExpression,
  type TimePredicate,
} from "@unblock/core";

export interface MatcherFragmentLoweringOptions {
  fragmentIdPrefix?: string;
  authoringImportPath?: string;
  appImportPath?: string;
}

export interface MatcherFragmentLowering {
  fragmentId: string;
  selectorHash: string;
  sourceHash: string;
  source: string;
  queryPlan?: QirQueryPlan;
  usesDynamicTime: boolean;
  input(now?: Date, projectId?: string): Record<string, string>;
}

type QirExpr =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; root: string; path: string[] }
  | { kind: "parameter"; name: string; path: string[] }
  | { kind: "unary"; op: "not" | "is_null" | "is_not_null"; expr: QirExpr }
  | { kind: "binary"; op: "eq" | "not_eq" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "add" | "starts_with"; left: QirExpr; right: QirExpr }
  | { kind: "call"; function: "key" | "lower" | "upper" | "coalesce"; args: QirExpr[] };

type QirNode =
  | { kind: "scan"; scan: QirScan }
  | { kind: "filter"; input: QirNode; predicate: QirExpr }
  | { kind: "project"; input: QirNode; fields: Array<{ name: string; expr: QirExpr }> }
  | { kind: "join"; left: QirNode; right: QirNode; join_type: "left" | "inner"; on: QirExpr };

type QirScan = { kind: "surface"; app_id: "unblock"; surface: BaseSurface | "taskLabelRows" | "taskDependencyClosure" | "hierarchyClosure" | "commentRows" };

interface QirQueryPlan {
  query_ir_version: 1;
  plan_id: string;
  root: QirNode;
  output: { kind: "rows"; fields: Array<{ name: string; ty: { kind: "text" }; nullable: boolean }> };
  shard_scope: "projected_cross_shard";
  dependencies: unknown[];
  temporal: null;
  reconciliation: null;
  required_features: string[];
  source: { kind: "generated"; generator: string };
}

interface JoinSpec {
  importName: "taskLabelRows" | "taskDependencyClosure" | "hierarchyClosure" | "commentRows";
  on(index: number, right: string): string;
}

type BaseSurface = "taskRows" | "taskReadModel" | "taskCommentMatcherModel" | "taskAssignmentMatcherModel" | "taskMatcherReadModel";

interface LowerContext {
  joins: JoinSpec[];
  times: TimeExpression[];
  tagJoin(values: string[], mode: "in" | "not-in"): string;
  graphJoin(predicate: GraphPredicate): string;
  hierarchyJoin(predicate: HierarchyPredicate): string;
  commentAuthorJoin(value: string): string;
  timeInput(expression: TimeExpression): { start: string; end: string | null };
}

export function lowerMatcherQueryToPrismFragment(query: string, options: MatcherFragmentLoweringOptions = {}): MatcherFragmentLowering {
  const ast = parseMatcherQuery(query);
  const selectorHash = stableHash(JSON.stringify(ast));
  const fragmentId = `${options.fragmentIdPrefix ?? "matcher"}_${selectorHash.slice(0, 16)}`;
  const context: LowerContext = {
    joins: [],
    times: [],
    tagJoin(values, mode) {
      const normalizedValues = values.map((value) => value.toLowerCase());
      const index = this.joins.length;
      this.joins.push({
        importName: "taskLabelRows",
        on: (joinIndex, label) => {
          const task = taskPathForJoin(joinIndex);
          const labelMatches = normalizedValues
            .map((value) =>
              `${label}.label_id.toLowerCase() === ${literalString(value)} || ${label}.name.toLowerCase() === ${literalString(value)}`
            )
            .join(" || ");
          const predicate = mode === "in" ? `(${labelMatches})` : `!(${labelMatches})`;
          return `${task}.id === ${label}.task_id && ${task}.project_id === ${label}.project_id && ${predicate}`;
        },
      });
      return joinToken(index);
    },
    graphJoin(predicate) {
      const index = this.joins.length;
      const targetId = predicate.targetId ?? "";
      this.joins.push({
        importName: "taskDependencyClosure",
        on: (joinIndex, edge) => {
          const task = taskPathForJoin(joinIndex);
          if (predicate.verb === "depends on") {
            return `${task}.id === ${edge}.from_id && ${task}.project_id === ${edge}.scope_key && ${edge}.from_kind === "Task" && ${edge}.to_kind === "Task" && ${edge}.to_id === ${literalString(targetId)}`;
          }
          return `${task}.id === ${edge}.to_id && ${task}.project_id === ${edge}.scope_key && ${edge}.from_kind === "Task" && ${edge}.to_kind === "Task" && ${edge}.from_id === ${literalString(targetId)}`;
        },
      });
      return joinToken(index);
    },
    hierarchyJoin(predicate) {
      const index = this.joins.length;
      this.joins.push({
        importName: "hierarchyClosure",
        on: (joinIndex, edge) => {
          const task = taskPathForJoin(joinIndex);
          return `${task}.id === ${edge}.to_id && ${task}.project_id === ${edge}.scope_key && ${edge}.from_kind === "Task" && ${edge}.to_kind === "Task" && ${edge}.from_id === ${literalString(predicate.taskId)}`;
        },
      });
      return joinToken(index);
    },
    commentAuthorJoin(value) {
      const index = this.joins.length;
      const expected = value.toLowerCase();
      this.joins.push({
        importName: "commentRows",
        on: (joinIndex, comment) => {
          const task = taskPathForJoin(joinIndex);
          return `${task}.id === ${comment}.task_id && ${task}.project_id === ${comment}.project_id && ${comment}.archived_at === null && (${comment}.machine + ":" + ${comment}.actor).toLowerCase() === ${literalString(expected)}`;
        },
      });
      return joinToken(index);
    },
    timeInput(expression) {
      const index = this.times.length;
      this.times.push(expression);
      return { start: `t${index}_start`, end: expressionHasEnd(expression) ? `t${index}_end` : null };
    },
  };
  const rawPredicate = lowerNode(ast, "__TASK__", context);
  const totalJoins = context.joins.length;
  const task = baseTaskPath(totalJoins);
  const predicate = replaceJoinTokens(rawPredicate, totalJoins).replaceAll("__TASK__", task);
  const baseSurface = baseSurfaceForQuery(ast);
  const authoringImportPath = options.authoringImportPath ?? "../../../../prism-new2/packages/prism-authoring/mod.ts";
  const appImportPath = options.appImportPath ?? "../src/app.ts";
  const inputSchemaFields = ["project_id: z.string()", ...context.times.flatMap((time, index) =>
    expressionHasEnd(time)
      ? [`t${index}_start: z.string().datetime()`, `t${index}_end: z.string().datetime()`]
      : [`t${index}_start: z.string().datetime()`]
  )];
  const sourceImports = [...new Set([baseSurface, ...context.joins.map((join) => join.importName)])];
  const source = [
    `import { z } from ${literalString(authoringImportPath)};`,
    `import { Unblock, ${sourceImports.join(", ")} } from ${literalString(appImportPath)};`,
    "",
    `Unblock.surface.query(${literalString(fragmentId)})`,
    `  .input(z.object({ ${inputSchemaFields.join(", ")} }))`,
    "  .returns(z.object({",
    "    project_id: z.string(),",
    "    task_id: z.string(),",
    "  }))",
    `  .from(${baseSurface})`,
    ...context.joins.map((join, index) =>
      `  .leftJoin(${join.importName}, (${leftArg(index)}: any, ${rightArg(join.importName)}: any) => ${join.on(index, rightArg(join.importName))})`
    ),
    `  .where((row: any, input: any) => ${task}.project_id === input.project_id && ${task}.archived_at === null && (${predicate}))`,
    "  .select((row: any) => ({",
    `    project_id: ${task}.project_id,`,
    `    task_id: ${task}.id,`,
    "  }));",
    "",
  ].join("\n");
  const sourceHash = stableHash(source);
  const queryPlan = lowerMatcherQueryToQirPlan(ast, fragmentId);
  return {
    fragmentId,
    selectorHash,
    sourceHash,
    source,
    ...(queryPlan ? { queryPlan } : {}),
    usesDynamicTime: context.times.length > 0,
    input(now = new Date(), projectId = "") {
      return {
        project_id: projectId,
        ...Object.fromEntries(context.times.flatMap((expression, index) => {
          const resolved = resolveTimeExpression(expression, now);
          return resolved.end
            ? [[`t${index}_start`, resolved.start.toISOString()], [`t${index}_end`, resolved.end.toISOString()]]
            : [[`t${index}_start`, resolved.start.toISOString()]];
        })),
      };
    },
  };
}

function baseSurfaceForQuery(node: QueryNode): BaseSurface {
  let rank = 0;
  const visit = (item: QueryNode): void => {
    switch (item.type) {
      case "and":
      case "or":
        item.nodes.forEach(visit);
        return;
      case "not":
        visit(item.node);
        return;
      case "field":
        rank = Math.max(rank, baseSurfaceRankForField(item));
        return;
      case "comment":
        rank = Math.max(rank, item.relation === "since" ? 2 : 0);
        return;
      case "graph":
        rank = Math.max(rank, item.targetId ? 0 : 4);
        return;
      case "hierarchy":
      case "time":
        return;
    }
  };
  visit(node);
  return baseSurfaceForRank(rank);
}

function baseSurfaceRankForField(predicate: FieldPredicate): number {
  switch (predicate.field) {
    case "status":
      return 1;
    case "comments":
      return 2;
    case "assigned":
    case "machine":
    case "actor":
      return 3;
    case "parent":
      return 4;
    default:
      return 0;
  }
}

function baseSurfaceForRank(rank: number): BaseSurface {
  if (rank >= 4) return "taskMatcherReadModel";
  if (rank === 3) return "taskAssignmentMatcherModel";
  if (rank === 2) return "taskCommentMatcherModel";
  if (rank === 1) return "taskReadModel";
  return "taskRows";
}

function lowerMatcherQueryToQirPlan(node: QueryNode, fragmentId: string): QirQueryPlan | null {
  const joins: Array<{ surface: QirScan["surface"]; on(index: number): QirExpr; matched(totalJoins: number): QirExpr }> = [];
  const predicateBuilder = lowerNodeToQir(node, joins);
  if (!predicateBuilder) return null;
  const totalJoins = joins.length;
  const task = taskExpr(totalJoins);
  let input: QirNode = scanSurface(baseSurfaceForQuery(node));
  joins.forEach((join, index) => {
    input = {
      kind: "join",
      left: input,
      right: scanSurface(join.surface),
      join_type: "left",
      on: join.on(index),
    };
  });
  const predicate = andExpr([
    eq(pathExpr(task.root, [...task.path, "project_id"]), parameter("project_id")),
    eq(pathExpr(task.root, [...task.path, "archived_at"]), literal(null)),
    predicateBuilder(totalJoins),
  ]);
  return {
    query_ir_version: 1,
    plan_id: fragmentId,
    root: {
      kind: "project",
      input: {
        kind: "filter",
        input,
        predicate,
      },
      fields: [
        { name: "project_id", expr: pathExpr(task.root, [...task.path, "project_id"]) },
        { name: "task_id", expr: pathExpr(task.root, [...task.path, "id"]) },
      ],
    },
    output: {
      kind: "rows",
      fields: [
        { name: "project_id", ty: { kind: "text" }, nullable: false },
        { name: "task_id", ty: { kind: "text" }, nullable: false },
      ],
    },
    shard_scope: "projected_cross_shard",
    dependencies: [],
    temporal: null,
    reconciliation: null,
    required_features: [],
    source: { kind: "generated", generator: "unblock.matcher.dsl" },
  };
}

function lowerNodeToQir(
  node: QueryNode,
  joins: Array<{ surface: QirScan["surface"]; on(index: number): QirExpr; matched(totalJoins: number): QirExpr }>,
): ((totalJoins: number) => QirExpr) | null {
  switch (node.type) {
    case "and": {
      const children = node.nodes.map((child) => lowerNodeToQir(child, joins));
      if (children.some((child) => child === null)) return null;
      return (totalJoins) => andExpr(children.map((child) => child!(totalJoins)));
    }
    case "or": {
      const children = node.nodes.map((child) => lowerNodeToQir(child, joins));
      if (children.some((child) => child === null)) return null;
      return (totalJoins) => orExpr(children.map((child) => child!(totalJoins)));
    }
    case "not": {
      const child = lowerNodeToQir(node.node, joins);
      return child ? (totalJoins) => ({ kind: "unary", op: "not", expr: child(totalJoins) }) : null;
    }
    case "field":
      return lowerFieldToQir(node, joins);
    case "graph":
      return lowerGraphToQir(node, joins);
    case "hierarchy":
    case "comment":
    case "time":
      return null;
  }
}

function lowerFieldToQir(
  predicate: FieldPredicate,
  joins: Array<{ surface: QirScan["surface"]; on(index: number): QirExpr; matched(totalJoins: number): QirExpr }>,
): ((totalJoins: number) => QirExpr) | null {
  if (predicate.field === "tag") {
    const normalizedValues = predicate.values.map((value) => value.toLowerCase());
    const index = joins.length;
    joins.push({
      surface: "taskLabelRows",
      on(joinIndex) {
        const task = taskExprForJoin(joinIndex);
        const labelMatches = orExpr(normalizedValues.flatMap((value) => [
          eq(lower(pathExpr("right", ["label_id"])), literal(value)),
          eq(lower(pathExpr("right", ["name"])), literal(value)),
        ]));
        return andExpr([
          eq(pathExpr(task.root, [...task.path, "id"]), pathExpr("right", ["task_id"])),
          eq(pathExpr(task.root, [...task.path, "project_id"]), pathExpr("right", ["project_id"])),
          predicate.op === "!=" ? notExpr(labelMatches) : labelMatches,
        ]);
      },
      matched(totalJoins) {
        return notNull(joinExpr(index, totalJoins));
      },
    });
    return (totalJoins) => predicate.op === "not in"
      ? isNull(joinExpr(index, totalJoins))
      : notNull(joinExpr(index, totalJoins));
  }
  if (predicate.field === "priority" && isNumericCompareOp(predicate.op)) {
    const priority = parsePriority(predicate.values[0] ?? "");
    const op = predicate.op;
    return (totalJoins) => compare(pathExprForTask(totalJoins, "priority"), op, literal(priority));
  }
  if (predicate.op !== "=" && predicate.op !== "!=") return null;
  if (predicate.field === "id" || predicate.field === "lifecycle" || predicate.field === "status") {
    const field = predicate.field === "status" ? "computed_status" : predicate.field;
    const expected = predicate.field === "id" ? predicate.values[0]?.toUpperCase() ?? "" : predicate.values[0]?.toLowerCase() ?? "";
    return (totalJoins) => {
      const value = predicate.field === "id" ? upper(pathExprForTask(totalJoins, field)) : lower(pathExprForTask(totalJoins, field));
      const equality = andExpr([notNull(pathExprForTask(totalJoins, field)), eq(value, literal(expected))]);
      return predicate.op === "=" ? equality : andExpr([notNull(pathExprForTask(totalJoins, field)), notExpr(equality)]);
    };
  }
  return null;
}

function lowerGraphToQir(
  predicate: GraphPredicate,
  joins: Array<{ surface: QirScan["surface"]; on(index: number): QirExpr; matched(totalJoins: number): QirExpr }>,
): ((totalJoins: number) => QirExpr) | null {
  if (!predicate.targetId) {
    const countField = predicate.verb === "depends on" ? "dependency_count" : "unblocks_count";
    const count = predicate.count ?? { op: ">" as CompareOp, value: 0 };
    return (totalJoins) => compare(pathExprForTask(totalJoins, countField), count.op, literal(count.value));
  }
  const index = joins.length;
  const targetId = predicate.targetId;
  joins.push({
    surface: "taskDependencyClosure",
    on(joinIndex) {
      const task = taskExprForJoin(joinIndex);
      const fromTask = predicate.verb === "depends on";
      return andExpr([
        eq(pathExpr(task.root, [...task.path, "id"]), pathExpr("right", [fromTask ? "from_id" : "to_id"])),
        eq(pathExpr(task.root, [...task.path, "project_id"]), pathExpr("right", ["scope_key"])),
        eq(pathExpr("right", ["from_kind"]), literal("Task")),
        eq(pathExpr("right", ["to_kind"]), literal("Task")),
        eq(pathExpr("right", [fromTask ? "to_id" : "from_id"]), literal(targetId)),
      ]);
    },
    matched(totalJoins) {
      return notNull(joinExpr(index, totalJoins));
    },
  });
  return (totalJoins) => {
    const clauses = [notNull(joinExpr(index, totalJoins))];
    if (predicate.depth) {
      clauses.push(compare(pathExprForJoinResult(index, totalJoins, "min_depth"), predicate.depth.op, literal(predicate.depth.value)));
    }
    return andExpr(clauses);
  };
}

function lowerNode(node: QueryNode, task: string, context: LowerContext): string {
  switch (node.type) {
    case "and":
      return node.nodes.map((child) => `(${lowerNode(child, task, context)})`).join(" && ");
    case "or":
      return node.nodes.map((child) => `(${lowerNode(child, task, context)})`).join(" || ");
    case "not":
      return `!(${lowerNode(node.node, task, context)})`;
    case "field":
      return lowerField(node, task, context);
    case "time":
      return lowerTime(node, task, context);
    case "comment":
      if (node.relation === "by") {
        return `${context.commentAuthorJoin(String(node.value))} !== null`;
      }
      return lowerTimestamp(`${task}.last_comment_at`, ">=", node.value as TimeExpression, context);
    case "graph":
      return lowerGraph(node, task, context);
    case "hierarchy":
      return `${context.hierarchyJoin(node)} !== null`;
  }
}

function lowerField(predicate: FieldPredicate, task: string, context: LowerContext): string {
  if (predicate.field === "tag") {
    if (predicate.op === "not in") return `${context.tagJoin(predicate.values, "in")} === null`;
    if (predicate.op === "!=") return `${context.tagJoin(predicate.values, "not-in")} !== null`;
    return `${context.tagJoin(predicate.values, "in")} !== null`;
  }
  if (predicate.op === "in" || predicate.op === "not in") {
    const inSet = predicate.values.map((value) => lowerFieldComparison(predicate.field, "=", value, task)).join(" || ");
    return predicate.op === "in" ? `(${inSet})` : `!(${inSet})`;
  }
  return lowerFieldComparison(predicate.field, predicate.op, predicate.values[0] ?? "", task);
}

function lowerFieldComparison(field: FieldName, op: CompareOp, expected: string, task: string): string {
  if (field === "priority") return compareNumber(`${task}.priority`, op, parsePriority(expected));
  if (field === "comments") return compareNumber(`${task}.comment_count`, op, Number(expected));
  if (field === "assigned") return lowerAssignedComparison(task, op, expected);
  if (field === "id prefix") {
    const starts = `${task}.id.toUpperCase().startsWith(${literalString(expected.toUpperCase())})`;
    return op === "=" ? starts : op === "!=" ? `!(${starts})` : "false";
  }
  const values = fieldValueExpressions(field, task);
  if (values.length === 0) return "false";
  const comparisons = values.map((value) => compareString(value, op, expected, field)).join(" || ");
  return `(${comparisons})`;
}

function lowerAssignedComparison(task: string, op: CompareOp, expected: string): string {
  if (op !== "=" && op !== "!=") return "false";
  const normalized = literalString(expected.toLowerCase());
  const hasAssignment = `${task}.assigned_machine !== null && ${task}.assigned_actor !== null`;
  const full = `(${hasAssignment} && (${task}.assigned_machine + ":" + ${task}.assigned_actor).toLowerCase() === ${normalized})`;
  const actor = `(${task}.assigned_actor !== null && ${task}.assigned_actor.toLowerCase() === ${normalized})`;
  const equality = `(${full} || ${actor})`;
  if (op === "=") return equality;
  return `((${hasAssignment}) && !${equality})`;
}

function fieldValueExpressions(field: FieldName, task: string): string[] {
  switch (field) {
    case "id":
      return [`${task}.id`];
    case "assigned":
      return [];
    case "machine":
      return [`${task}.assigned_machine`];
    case "actor":
      return [`${task}.assigned_actor`];
    case "status":
      return [`${task}.computed_status`];
    case "lifecycle":
      return [`${task}.lifecycle`];
    case "parent":
      return [`${task}.parent_task_id ?? "root"`];
    case "source doc":
      return [`${task}.source_doc`];
    case "source section":
      return [`${task}.source_section`];
    default:
      return [];
  }
}

function compareString(left: string, op: CompareOp, expected: string, field: FieldName): string {
  if (op !== "=" && op !== "!=") return "false";
  const normalize = field === "id" || field === "parent" ? "toUpperCase" : "toLowerCase";
  const expectedValue = normalize === "toUpperCase" ? expected.toUpperCase() : expected.toLowerCase();
  const equality = `${left} !== null && ${left}.${normalize}() === ${literalString(expectedValue)}`;
  return op === "=" ? equality : `(${left} !== null && !(${equality}))`;
}

function lowerTime(predicate: TimePredicate, task: string, context: LowerContext): string {
  const field = `${task}.${timeField(predicate.field)}`;
  if (predicate.op === "is empty") return `${field} === null`;
  if (predicate.op === "is not empty") return `${field} !== null`;
  return lowerTimestamp(field, predicate.op, predicate.value as TimeExpression, context);
}

function lowerTimestamp(left: string, op: CompareOp, expression: TimeExpression, context: LowerContext): string {
  const input = context.timeInput(expression);
  if (input.end) {
    if (op === "=") return `${left} !== null && ${left} >= input.${input.start} && ${left} < input.${input.end}`;
    if (op === "!=") return `${left} !== null && (${left} < input.${input.start} || ${left} >= input.${input.end})`;
  }
  return `${left} !== null && ${compareStringTime(left, op, `input.${input.start}`)}`;
}

function lowerGraph(predicate: GraphPredicate, task: string, context: LowerContext): string {
  if (predicate.targetId) {
    const edge = context.graphJoin(predicate);
    const depth = predicate.depth ? ` && ${compareNumber(`${edge}.min_depth`, predicate.depth.op, predicate.depth.value)}` : "";
    return `${edge} !== null${depth}`;
  }
  const countField = predicate.verb === "depends on" ? "dependency_count" : "unblocks_count";
  const count = predicate.count ?? { op: ">" as CompareOp, value: 0 };
  return compareNumber(`${task}.${countField}`, count.op, count.value);
}

function compareNumber(left: string, op: CompareOp, right: number): string {
  return `${left} ${op === "=" ? "===" : op === "!=" ? "!==" : op} ${right}`;
}

function compareStringTime(left: string, op: CompareOp, right: string): string {
  return `${left} ${op === "=" ? "===" : op === "!=" ? "!==" : op} ${right}`;
}

function timeField(field: TimePredicate["field"]): string {
  if (field === "created") return "created_at";
  if (field === "updated") return "updated_at";
  if (field === "started") return "started_at";
  if (field === "finished") return "finished_at";
  return "archived_at";
}

function parsePriority(value: string): number {
  const parsed = Number(value.toUpperCase().startsWith("P") ? value.slice(1) : value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid priority value: ${value}`);
  return parsed;
}

function replaceJoinTokens(input: string, totalJoins: number): string {
  return input.replace(/__JOIN_(\d+)__/g, (_match, index) => joinPath(Number(index), totalJoins));
}

function joinToken(index: number): string {
  return `__JOIN_${index}__`;
}

function baseTaskPath(totalJoins: number): string {
  return `row${".left".repeat(totalJoins)}`;
}

function taskPathForJoin(joinIndex: number): string {
  return `left${".left".repeat(joinIndex)}`;
}

function joinPath(index: number, totalJoins: number): string {
  if (index === totalJoins - 1) return "row.right";
  return `row${".left".repeat(totalJoins - index - 1)}.right`;
}

function scanSurface(surface: QirScan["surface"]): QirNode {
  return { kind: "scan", scan: { kind: "surface", app_id: "unblock", surface } };
}

function literal(value: unknown): QirExpr {
  return { kind: "literal", value };
}

function pathExpr(root: string, path: string[]): QirExpr {
  return { kind: "path", root, path };
}

function parameter(name: string): QirExpr {
  return { kind: "parameter", name, path: [] };
}

function taskExpr(totalJoins: number): { root: string; path: string[] } {
  return { root: "row", path: Array.from({ length: totalJoins }, () => "left") };
}

function taskExprForJoin(joinIndex: number): { root: string; path: string[] } {
  return { root: "left", path: Array.from({ length: joinIndex }, () => "left") };
}

function joinExpr(index: number, totalJoins: number): QirExpr {
  return pathExpr("row", joinResultPath(index, totalJoins));
}

function pathExprForJoinResult(index: number, totalJoins: number, field: string): QirExpr {
  return pathExpr("row", [...joinResultPath(index, totalJoins), field]);
}

function joinResultPath(index: number, totalJoins: number): string[] {
  if (index === totalJoins - 1) return ["right"];
  return [...Array.from({ length: totalJoins - index - 1 }, () => "left"), "right"];
}

function pathExprForTask(totalJoins: number, field: string): QirExpr {
  const task = taskExpr(totalJoins);
  return pathExpr(task.root, [...task.path, field]);
}

function eq(left: QirExpr, right: QirExpr): QirExpr {
  return { kind: "binary", op: "eq", left, right };
}

function notExpr(expr: QirExpr): QirExpr {
  return { kind: "unary", op: "not", expr };
}

function isNull(expr: QirExpr): QirExpr {
  return { kind: "unary", op: "is_null", expr };
}

function notNull(expr: QirExpr): QirExpr {
  return { kind: "unary", op: "is_not_null", expr };
}

function lower(expr: QirExpr): QirExpr {
  return { kind: "call", function: "lower", args: [expr] };
}

function upper(expr: QirExpr): QirExpr {
  return { kind: "call", function: "upper", args: [expr] };
}

function compare(left: QirExpr, op: CompareOp, right: QirExpr): QirExpr {
  return { kind: "binary", op: qirCompareOp(op), left, right };
}

function andExpr(items: QirExpr[]): QirExpr {
  return items.reduce((left, right) => ({ kind: "binary", op: "and", left, right }));
}

function orExpr(items: QirExpr[]): QirExpr {
  if (items.length === 0) return literal(false);
  return items.reduce((left, right) => ({ kind: "binary", op: "or", left, right }));
}

function qirCompareOp(op: CompareOp): "eq" | "not_eq" | "lt" | "lte" | "gt" | "gte" {
  if (op === "=") return "eq";
  if (op === "!=") return "not_eq";
  if (op === "<") return "lt";
  if (op === "<=") return "lte";
  if (op === ">") return "gt";
  return "gte";
}

function isNumericCompareOp(op: FieldPredicate["op"]): op is CompareOp {
  return op === "=" || op === "!=" || op === ">" || op === ">=" || op === "<" || op === "<=";
}

function leftArg(index: number): string {
  return index === 0 ? "left" : "left";
}

function rightArg(_importName: JoinSpec["importName"]): string {
  return "right";
}

function expressionHasEnd(expression: TimeExpression): boolean {
  return expression.type === "today" || (expression.type === "absolute" && expression.dateOnly);
}

function resolveTimeExpression(expression: TimeExpression, now: Date): { start: Date; end?: Date } {
  if (expression.type === "now") return { start: now };
  if (expression.type === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start, end: addDays(start, 1) };
  }
  if (expression.type === "relative") {
    return { start: new Date(now.getTime() - durationMs(expression.amount, expression.unit)) };
  }
  if (expression.dateOnly) {
    const [year, month, day] = expression.value.split("-").map(Number);
    const start = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
    return { start, end: addDays(start, 1) };
  }
  return { start: new Date(expression.value.includes(" ") ? expression.value.replace(" ", "T") : expression.value) };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function durationMs(amount: number, unit: "m" | "h" | "d" | "w"): number {
  const minute = 60 * 1000;
  if (unit === "m") return amount * minute;
  if (unit === "h") return amount * 60 * minute;
  if (unit === "d") return amount * 24 * 60 * minute;
  return amount * 7 * 24 * 60 * minute;
}

function literalString(value: string): string {
  return JSON.stringify(value);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
