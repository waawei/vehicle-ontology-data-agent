---
name: vehicle-domain
description: 使用车辆 Ontology 与受治理数据工具回答已发布的临租订单数、长租车辆数、供应商分组和业务月份比较问题。
---

# Vehicle Domain

本 Skill 是公开演示仓库的跨模型领域规则。Pi Agent 负责识别意图、加载 Skill 和
调用工具；模型 Provider 不是车辆业务合同或数据权限的权威来源。

## 当前可执行能力

| Metric ID | 中文名称 | 聚合 | 时间 | 可用分组 |
|---|---|---|---|---|
| `vehicle.count.short_rental_order` | 临租订单数 | 去重订单数 | 业务月份 | 供应商 |
| `vehicle.count.long_rental_vehicle` | 长租车辆数 | 去重车辆数 | 业务月份 | 供应商 |

可用工具：

- `ontology_search`：按名称或 semantic ID 搜索公开语义投影。
- `ontology_describe`：读取指标口径、粒度、允许维度、时间语义和能力限制。
- `vehicle_aggregate`：执行一个月份的受治理计数或供应商分组。
- `vehicle_compare`：在同指标、同 Principal 范围、同过滤条件下比较两个业务月份。

## 执行流程

1. 从当前问题和 thread 上下文确定指标、业务月份、是否分组或比较。
2. 指标或维度不明确时先调用 Ontology 工具，不猜 metric ID、物理表或字段。
3. 单月计数或分组调用 `vehicle_aggregate`；跨月比较调用 `vehicle_compare`。
4. 只提交 semantic metric、`business_month`、已发布维度和等值过滤。
5. 不提交、索取、展示或推断组织 ID。组织范围只由数据服务从 Principal 注入。
6. 以工具返回的 structured observation 作为数字事实；不得自行从明细、历史答案、
   fixture 说明或模型常识计算业务数值。
7. 工具失败时说明错误码和缺少的条件，不编造 N，不用演示值代替实时结果。

## 自然追问

对以下追问应继承 thread 中最近一次已确认的指标与时间，不要求用户重复完整问题：

- `按供应商分组`
- `和 5 月比较`
- `改看 2026 年 5 月`

如果 thread 中同时存在多个可能指标，必须先澄清，不得擅自把长租问题路由为临租。

## 输出规则

- 第一行先直接回答：`2026 年 6 月临租订单数为 11 单。`
- 随后按需要说明比较方向、绝对变化、百分比或供应商结构。
- 数字必须保留工具给出的时间、单位、聚合口径和完整性。
- `completeness` 只表示本次查询是否完整执行以及分组结果是否截断。
- 组织归属质量只使用 `dataQuality.organizationAttribution`；没有测量元数据时写明
  `not_measured`，不能从本次查询成功推断全局覆盖率。
- 将工具活动和技术来源放在业务结论之后，避免生成普通只读计数的长篇报告。

## 安全与口径约束

- 禁止模型生成或修改 SQL。
- 禁止浏览器或模型提交、选择、分组或看到真实组织 ID。
- 禁止先拉取分页明细再声称得到全量 count、sum、avg 或 group-by。
- 禁止把物理字段名、连接凭据或私有 mount 暴露给模型。
- 临租订单数按正式订单身份键 `count_distinct`，不是原始行数。
- 长租车辆数按正式车辆身份键 `count_distinct`，不是租赁记录行数。
- 业务月份必须由数据服务按 dataset time encoding 编译，不能把 `YYYY-MM` 或 ISO
  timestamp 与未知源字符串直接比较。
- 供应商分组最多返回已发布上限；发生截断时不得表述为完整分布。
- 车辆和员工属于高基数维度，在没有结果上限与脱敏策略前不可分组。

## 明确未发布的能力

下列问题可做语义解释或澄清，但不能给出数据结论：

- 费用、金额、TCO、预算；
- 合同、保险、到期；
- 异常、风险、审计命中；
- 任意明细列表或任意 SQL；
- 未进入公开 Semantic Index 的指标；
- 生产数据库中的任何数值或标识。

应明确说明“当前没有已发布的 governed metric/tool”，并指出需要新增的 Metric
Definition、字段绑定、质量规则或明细访问策略，不得把自由分析写成已验证事实。
