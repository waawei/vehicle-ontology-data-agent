import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { OntologyCatalog, type OntologyKind } from "./ontology.js";

const OntologySearchInput = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200 }),
  kinds: Type.Optional(Type.Array(Type.Union([
    Type.Literal("metric"),
    Type.Literal("entity"),
    Type.Literal("event"),
    Type.Literal("field"),
    Type.Literal("relation"),
    Type.Literal("time"),
  ]), { maxItems: 6 })),
}, { additionalProperties: false });

const OntologyDescribeInput = Type.Object({
  semanticId: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });

export function createOntologySearchTool(catalog: OntologyCatalog): AgentTool<typeof OntologySearchInput> {
  return {
    name: "ontology_search",
    label: "Ontology 语义检索",
    description: "搜索正式 Semantic Index 中的指标、实体、事件、字段、关系和时间语义。返回模型安全视图，不返回物理表、物理列或组织 ID。",
    parameters: OntologySearchInput,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => observation(catalog.search(
      parameters.query,
      (parameters.kinds ?? []) as OntologyKind[],
    )),
  };
}

export function createOntologyDescribeTool(catalog: OntologyCatalog): AgentTool<typeof OntologyDescribeInput> {
  return {
    name: "ontology_describe",
    label: "Ontology 语义说明",
    description: "读取一个正式 semantic ID 的完整业务合同、允许操作和 capability gap。不得用于推断物理 SQL。",
    parameters: OntologyDescribeInput,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => {
      const item = catalog.describe(parameters.semanticId);
      if (!item) throw new Error("ONTOLOGY_ITEM_NOT_FOUND: Semantic item does not exist");
      return observation(item);
    },
  };
}

function observation(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { observation: value },
  };
}
