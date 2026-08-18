import type { RuntimeConfig } from "./config.js";
import type { OntologyCatalog } from "./ontology.js";

export type SkillStatus = "available" | "limited";

export type RuntimeToolName =
  | "ontology_search"
  | "ontology_describe"
  | "vehicle_aggregate"
  | "vehicle_compare";

export interface SkillRouteContext {
  previousSkillId?: string;
}

type SkillMatcher = (content: string, context: SkillRouteContext) => boolean;

export interface RuntimeSkill {
  id: string;
  label: string;
  summary: string;
  status: SkillStatus;
  prompt: string;
  toolNames: RuntimeToolName[];
  /** Runtime-only metric allowlist enforced before a vehicle tool call. */
  allowedMetricIds: string[];
  /** Runtime-only instructions. They are never returned by /workspace. */
  executionPrompt: string;
  matcher: SkillMatcher;
}

export type PublicRuntimeSkill = Omit<RuntimeSkill, "allowedMetricIds" | "executionPrompt" | "matcher">;

export interface SkillRoute {
  skillId: string;
  label: string;
  matched: boolean;
}

const ontologyTools: RuntimeToolName[] = ["ontology_search", "ontology_describe"];
const vehicleTools: RuntimeToolName[] = [...ontologyTools, "vehicle_aggregate"];
const reportTools: RuntimeToolName[] = [...vehicleTools, "vehicle_compare"];
const SHORT_RENTAL_ORDER_METRIC = "vehicle.count.short_rental_order";
const LONG_RENTAL_VEHICLE_METRIC = "vehicle.count.long_rental_vehicle";

export const RUNTIME_SKILLS: RuntimeSkill[] = [
  {
    id: "vehicle.management_report",
    label: "车辆经营分析报告",
    summary: "主动分析 · 周期比较与驱动拆解",
    status: "available",
    prompt: "生成 2026 年 6 月临租订单经营分析报告",
    toolNames: reportTools,
    allowedMetricIds: [SHORT_RENTAL_ORDER_METRIC, LONG_RENTAL_VEHICLE_METRIC],
    executionPrompt:
      `只在用户明确要求报告、汇报、经营分析或管理总结时执行本 Skill。先确定报告期；缺少业务月份时先澄清，不得自行猜测。
对每个请求的业务类型，先用 ontology_describe 核对正式 metric 和口径。临租只能使用 vehicle.count.short_rental_order，长租只能使用 vehicle.count.long_rental_vehicle；两者粒度不同，不得相加或伪装成同一指标。
必须先调用一次不分组的 vehicle_compare，当前期使用报告期，基准期默认使用紧邻上一个业务月份，用户明确指定其他基准期时按用户要求。随后调用一次按 vehicle.dimension.supplier 分组的 vehicle_compare，用于识别结构变化；不得自行计算变化值、变化率或供应商排序。
最终直接输出专业 Markdown 报告，依次包含：标题与报告范围、执行摘要、核心指标表、周期变化、供应商变化贡献、风险与管理建议、口径与数据质量。执行摘要先回答最重要的变化；事实必须来自 structured comparison。把供应商变化表述为“变化贡献”或“结构变化”，除非存在额外证据，不得写成因果原因。建议必须明确属于管理建议，不能冒充数据事实。
若 comparison 为 partial、变化率因基准期为零不可计算、组织归属质量为 not_measured，必须在对应章节准确披露。不要展示隐藏思维过程，不要生成任意 SQL，不要读取明细，不要引用历史报告或示例数字。`,
    matcher: (content, context) => {
      const explicitReport = /(报告|汇报|经营分析|经营简报|分析总结|管理层|管理总结)/i.test(content);
      const vehicleContext = /(临租|短租|长租|订单|车辆|业务量)/i.test(content);
      const reportContinuation = context.previousSkillId === "vehicle.management_report"
        && /(继续|补充|展开|供应商|更新|改成|增加|对比|比较|报告)/i.test(content);
      return (explicitReport && vehicleContext) || reportContinuation;
    },
  },
  {
    id: "ontology.semantic_exploration",
    label: "Ontology 语义检索",
    summary: "自动调用 · 正式语义索引",
    status: "available",
    prompt: "临租订单数的正式指标定义和时间口径是什么？",
    toolNames: ontologyTools,
    allowedMetricIds: [],
    executionPrompt:
      "先用 ontology_search 找到正式 semantic ID，再按需要调用 ontology_describe。只回答正式语义、口径、允许的维度和可执行性；不要猜测物理表、物理列或组织 ID。",
    matcher: (content) => /ontology|本体|语义|指标定义|字段定义|时间口径|业务口径/i.test(content),
  },
  {
    id: "vehicle.rental_volume_comparison",
    label: "长短租业务量对照",
    summary: "自动调用 · 异粒度双指标",
    status: "available",
    prompt: "按供应商分组查询 2026 年 4 月长租和临租业务量",
    toolNames: vehicleTools,
    allowedMetricIds: [LONG_RENTAL_VEHICLE_METRIC, SHORT_RENTAL_ORDER_METRIC],
    executionPrompt:
      "长租没有已发布的订单身份或订单数指标。必须分别使用 vehicle.count.long_rental_vehicle（长租车辆数）和 vehicle.count.short_rental_order（临租订单数），不得把两者改名为同一口径、相加或计算比例。使用同一个 business_month；用户要求供应商分组时，两次调用都使用 groupByFieldIds [vehicle.dimension.supplier]，否则都不分组。先给出两个结构化 observation 的业务答案，再明确说明一个是去重车辆数、一个是去重订单数，不能直接比较规模。必须分别说明查询完整性，并把组织归属质量作为独立结论。",
    matcher: (content, context) => hasMixedRentalContext(content, context),
  },
  {
    id: "vehicle.period_comparison",
    label: "车辆指标对比",
    summary: "自动调用 · 双周期聚合",
    status: "available",
    prompt: "对比 2026 年 5 月和 6 月的临租订单数",
    toolNames: vehicleTools,
    allowedMetricIds: [SHORT_RENTAL_ORDER_METRIC],
    executionPrompt:
      "对比两个业务月份时，先确认同一个正式 metricId，然后分别调用 vehicle_aggregate 两次。只能比较结构化 observation；不得读取明细、自己生成 SQL 或用历史数字补齐。",
    matcher: (content, context) => /(对比|比较|环比|同比)/i.test(content) && hasShortRentalContext(content, context),
  },
  {
    id: "vehicle.long_rental_period_comparison",
    label: "长租车辆周期对比",
    summary: "自动调用 · 双周期车辆聚合",
    status: "available",
    prompt: "对比 2026 年 5 月和 6 月的长租车辆数",
    toolNames: vehicleTools,
    allowedMetricIds: [LONG_RENTAL_VEHICLE_METRIC],
    executionPrompt:
      "对比两个业务月份的长租车辆数时，只能使用正式 metricId vehicle.count.long_rental_vehicle，并分别调用 vehicle_aggregate 两次。指标是按车牌身份去重的车辆数，不是订单数；不得读取明细、自行生成 SQL 或用历史数字补齐。必须报告查询完整性，并把组织归属质量作为独立结论。",
    matcher: (content, context) => /(对比|比较|环比|同比)/i.test(content) && hasLongRentalContext(content, context),
  },
  {
    id: "vehicle.short_rental_supplier_breakdown",
    label: "临租供应商分组",
    summary: "自动调用 · 供应商维度聚合",
    status: "available",
    prompt: "按供应商分组查询 2026 年 6 月临租订单数",
    toolNames: vehicleTools,
    allowedMetricIds: [SHORT_RENTAL_ORDER_METRIC],
    executionPrompt:
      "按供应商分组时使用正式 metricId vehicle.count.short_rental_order 和 groupByFieldIds [vehicle.dimension.supplier]。先确认指标和允许维度，再调用一次 vehicle_aggregate；不要把供应商名称当作组织范围，也不要暴露组织 ID。",
    matcher: (content, context) => (
      /(按|按照|根据).*(供应商).*(分组|统计|查看)|(供应商).*(分组|维度)/i.test(content)
      && hasShortRentalContext(content, context)
    ),
  },
  {
    id: "vehicle.long_rental_supplier_breakdown",
    label: "长租供应商分组",
    summary: "自动调用 · 供应商维度车辆聚合",
    status: "available",
    prompt: "按供应商分组查询 2026 年 6 月长租车辆数",
    toolNames: vehicleTools,
    allowedMetricIds: [LONG_RENTAL_VEHICLE_METRIC],
    executionPrompt:
      "按供应商分组查询长租车辆数时，只能使用正式 metricId vehicle.count.long_rental_vehicle 和 groupByFieldIds [vehicle.dimension.supplier]。该指标按长租车辆身份去重，不是订单数；不要把供应商名称当作组织范围，也不要暴露组织 ID。必须报告查询完整性，并把组织归属质量作为独立结论。",
    matcher: (content, context) => (
      /(按|按照|根据).*(供应商).*(分组|统计|查看)|(供应商).*(分组|维度)/i.test(content)
      && hasLongRentalContext(content, context)
    ),
  },
  {
    id: "vehicle.short_rental_vehicle_breakdown",
    label: "临租车辆分组",
    summary: "语义可见 · 分组策略待发布",
    status: "limited",
    prompt: "按车辆分组查询 2026 年 6 月临租订单数",
    toolNames: ontologyTools,
    allowedMetricIds: [],
    executionPrompt:
      "vehicle.dimension.vehicle 当前绑定车牌语义，不代表车型；高基数分组的结果上限和脱敏策略尚未发布。只能解释该 capability gap，不得调用聚合或猜测车型字段。",
    matcher: (content, context) => (
      (/(按|按照|根据).*(车辆|车牌).*(分组|统计|查看)|(车辆|车牌).*(分组|维度)/i.test(content)
        || /车型/i.test(content))
      && hasShortRentalContext(content, context)
    ),
  },
  {
    id: "vehicle.short_rental_employee_breakdown",
    label: "临租员工分组",
    summary: "语义可见 · 分组策略待发布",
    status: "limited",
    prompt: "按员工分组查询 2026 年 6 月临租订单数",
    toolNames: ontologyTools,
    allowedMetricIds: [],
    executionPrompt:
      "员工高基数分组的结果上限与脱敏策略尚未发布。只能解释该 capability gap，不得调用聚合或输出员工标识。",
    matcher: (content, context) => (
      /(按|按照|根据).*(员工|申请人).*(分组|统计|查看)|(员工|申请人).*(分组|维度)/i.test(content)
      && hasShortRentalContext(content, context)
    ),
  },
  {
    id: "vehicle.short_rental_filtered_analysis",
    label: "临租条件筛选",
    summary: "自动调用 · 受治理条件过滤",
    status: "available",
    prompt: "查询 2026 年 6 月供应商为指定供应商的临租订单数",
    toolNames: vehicleTools,
    allowedMetricIds: [SHORT_RENTAL_ORDER_METRIC],
    executionPrompt:
      "需要筛选时使用 vehicle_aggregate 的 eq filters，并且只允许正式指标声明的 dimension fieldId，例如 vehicle.dimension.supplier、vehicle.dimension.vehicle 或 vehicle.dimension.employee。组织过滤永远不能由用户提交。缺少明确筛选值时先向用户澄清，不猜值。",
    matcher: (content, context) => {
      const hasFilterVerb = /(筛选|过滤|只看|限定|条件)/i.test(content);
      const hasDimensionValue = /(供应商|车辆|车牌|员工|申请人).*(为|等于|是)/i.test(content);
      return (hasFilterVerb || hasDimensionValue) && hasShortRentalContext(content, context);
    },
  },
  {
    id: "vehicle.short_rental_analysis",
    label: "临租订单分析",
    summary: "自动调用 · 受治理聚合",
    status: "available",
    prompt: "查询 2026 年 6 月的临租订单数",
    toolNames: vehicleTools,
    allowedMetricIds: [SHORT_RENTAL_ORDER_METRIC],
    executionPrompt:
      "查询临租订单数时使用正式 metricId vehicle.count.short_rental_order，业务月份使用 business_month YYYY-MM。先确认指标口径，再调用 vehicle_aggregate；不要使用 raw rows 或自行计算。",
    matcher: (content, context) => hasShortRentalContext(content, context)
      && /临租|短租|订单数|vehicle\.count\.short_rental_order/i.test(content),
  },
  {
    id: "vehicle.long_rental_analysis",
    label: "长租车辆分析",
    summary: "自动调用 · 受治理车辆聚合",
    status: "available",
    prompt: "查询 2026 年 6 月的长租车辆数",
    toolNames: vehicleTools,
    allowedMetricIds: [LONG_RENTAL_VEHICLE_METRIC],
    executionPrompt:
      "查询长租业务量时只能使用正式 metricId vehicle.count.long_rental_vehicle，业务月份使用 business_month YYYY-MM。这个指标按车辆身份去重，单位为辆；当前没有正式长租订单数。若用户说“长租订单数”，必须明确口径不存在，并把实际可执行结果标为长租车辆数，不能称为订单数。必须报告查询完整性，并把组织归属质量作为独立结论。",
    matcher: (content, context) => hasLongRentalContext(content, context)
      && /长租|车辆数|订单数|vehicle\.count\.long_rental_vehicle/i.test(content),
  },
];

const FREE_ANALYSIS_SKILL: RuntimeSkill = {
  id: "free.analysis",
  label: "自由分析",
  summary: "未匹配 Skill · 受限语义回答",
  status: "limited",
  prompt: "直接描述你的车辆业务问题",
  toolNames: ontologyTools,
  allowedMetricIds: [],
  executionPrompt:
    "当前问题没有匹配已发布的车辆数据 Skill。可以使用 Ontology 语义工具解释正式定义；不要调用车辆聚合，不要猜测数据或物理查询。",
  matcher: () => false,
};

const SKILL_DISPLAY_ORDER = [
  "vehicle.management_report",
  "vehicle.short_rental_analysis",
  "vehicle.long_rental_analysis",
  "vehicle.rental_volume_comparison",
  "ontology.semantic_exploration",
  "vehicle.period_comparison",
  "vehicle.long_rental_period_comparison",
  "vehicle.short_rental_supplier_breakdown",
  "vehicle.long_rental_supplier_breakdown",
  "vehicle.short_rental_vehicle_breakdown",
  "vehicle.short_rental_employee_breakdown",
  "vehicle.short_rental_filtered_analysis",
];

export function runtimeSkill(skillId: string): RuntimeSkill {
  return RUNTIME_SKILLS.find((skill) => skill.id === skillId) ?? FREE_ANALYSIS_SKILL;
}

export function publicRuntimeSkills(): PublicRuntimeSkill[] {
  return [...RUNTIME_SKILLS]
    .sort((left, right) => SKILL_DISPLAY_ORDER.indexOf(left.id) - SKILL_DISPLAY_ORDER.indexOf(right.id))
    .map(({
      allowedMetricIds: _allowedMetricIds,
      executionPrompt: _executionPrompt,
      matcher: _matcher,
      ...skill
    }) => skill);
}

export function routeIntent(content: string, context: SkillRouteContext = {}): SkillRoute {
  for (const skill of RUNTIME_SKILLS) {
    if (skill.matcher(content, context)) {
      return { skillId: skill.id, label: skill.label, matched: true };
    }
  }
  return { skillId: "free.analysis", label: "自由分析", matched: false };
}

function hasShortRentalContext(content: string, context: SkillRouteContext): boolean {
  if (/长租/i.test(content)) return false;
  if (/临租|短租|vehicle\.count\.short_rental_order/i.test(content)) return true;
  return Boolean(context.previousSkillId && SHORT_RENTAL_SKILL_IDS.has(context.previousSkillId));
}

function hasLongRentalContext(content: string, context: SkillRouteContext): boolean {
  if (/(临租|短租)/i.test(content)) return false;
  if (/长租|vehicle\.count\.long_rental_vehicle/i.test(content)) return true;
  return Boolean(context.previousSkillId && LONG_RENTAL_SKILL_IDS.has(context.previousSkillId));
}

function hasMixedRentalContext(content: string, context: SkillRouteContext): boolean {
  const asksForSupportedVolume = /(订单|车辆|业务量|数量|供应商|分组|统计|对比|比较)/i.test(content);
  const asksForUnsupportedCostOrRisk = /(费用|成本|金额|TCO|异常|预警|到期|保险|合同)/i.test(content);
  if (!asksForSupportedVolume || asksForUnsupportedCostOrRisk) return false;
  if (/长租/i.test(content) && /(临租|短租)/i.test(content)) return true;
  return context.previousSkillId === "vehicle.rental_volume_comparison";
}

const SHORT_RENTAL_SKILL_IDS = new Set([
  "vehicle.period_comparison",
  "vehicle.short_rental_supplier_breakdown",
  "vehicle.short_rental_vehicle_breakdown",
  "vehicle.short_rental_employee_breakdown",
  "vehicle.short_rental_filtered_analysis",
  "vehicle.short_rental_analysis",
]);

const LONG_RENTAL_SKILL_IDS = new Set([
  "vehicle.long_rental_period_comparison",
  "vehicle.long_rental_supplier_breakdown",
  "vehicle.long_rental_analysis",
]);

export function workspaceSnapshot(config: RuntimeConfig, catalog: OntologyCatalog) {
  const clickHouseDetail = config.clickHouseStatus === "online"
    ? "只读连接可用"
    : config.clickHouseStatus === "offline"
      ? "当前无法连接内网数据服务"
      : "尚未检查连接状态";
  return {
    schemaVersion: "pi-workspace.v1",
    skills: publicRuntimeSkills(),
    dataSources: [
      {
        id: "vehicle.ontology",
        label: "Ontology 语义层",
        description: `${catalog.counts.metrics} 指标 · ${catalog.counts.entities} 实体`,
        kind: "semantic",
        status: "online",
        readOnly: true,
        href: "/agent/ontology",
      },
      {
        id: "vehicle.clickhouse",
        label: "车辆数据仓库",
        description: clickHouseDetail,
        kind: "database",
        status: config.clickHouseStatus,
        readOnly: true,
        href: "/agent/workspace",
      },
    ],
    ontology: {
      workspaceId: catalog.workspaceId,
      resourceVersion: catalog.resourceVersion,
      counts: catalog.counts,
    },
    routing: {
      mode: "automatic",
      fallback: "free_analysis",
      modelId: config.modelId,
      thinkingLevel: config.thinkingLevel,
    },
  };
}
