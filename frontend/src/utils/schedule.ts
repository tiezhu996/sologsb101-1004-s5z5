/**
 * 待编排病害与作业单草稿之间的可行时段判断。
 * 只以负责人 / 作业人员 / 机具在同一时间的重叠占用为阻塞条件；
 * 已保存作业单只作为占用读取，计算结果仅用于回写当前表单草稿。
 */
import type { Fault, FaultSeverity } from '../types/fault';
import type { Inspection } from '../types/inspection';
import type { Switch } from '../types/switch';
import type { Yard } from '../types/yard';
import type { WorkOrder, WorkOrderDraft } from '../types/workOrder';
import { isOverlap, parseDateTime } from './window';

/** 按病害等级估算单处病害所需天窗工时（分钟） */
export const FAULT_SCHEDULE_MINUTES: Record<FaultSeverity, number> = {
  heavy: 60,
  medium: 45,
  light: 30,
};

const DEFAULT_HORIZON_DAYS = 7;
const MINUTE_MS = 60_000;

export interface ScheduleFaultContext {
  id: string;
  severity: FaultSeverity;
  yardId: string;
  yardName: string;
  switchId: string;
  switchCode: string;
  inspectionId: string;
  inspectionDate: string;
}

export interface ScheduledFault extends ScheduleFaultContext {
  start: string;
  end: string;
  minutes: number;
}

export type DeferredReason = 'heavy-overflow' | 'medium-overflow' | 'light-overflow';

export interface DeferredFault extends ScheduleFaultContext {
  reason: DeferredReason;
}

export interface FeasibleWindow {
  start: string;
  end: string;
  minutes: number;
}

export interface OccupationBlock {
  id: string;
  code: string;
  windowStart: string;
  windowEnd: string;
  /** 当前草稿负责人被占用时给出负责人姓名 */
  leaderNames: string[];
  /** 发生重叠的人员（含负责人） */
  people: string[];
  /** 发生重叠的机具 */
  machines: string[];
}

export interface RecommendedPlan {
  window: FeasibleWindow;
  scheduledIds: string[];
  deferredFaults: DeferredFault[];
}

export type FeasibilityStatus = 'ready' | 'deferred' | 'blocked';

export interface FeasibilityResult {
  status: FeasibilityStatus;
  canSave: boolean;
  error: string;
  currentGap: FeasibleWindow | null;
  suggestedWindow: FeasibleWindow | null;
  recommendedPlan: RecommendedPlan | null;
  /** 当前间隙放不下、但后续间隙可容纳更多病害时的替代排法 */
  laterPlan: RecommendedPlan | null;
  scheduledFaults: ScheduledFault[];
  deferredFaults: DeferredFault[];
  blockingOccupations: OccupationBlock[];
  /** 与当前表单时间窗直接重叠的资源占用 */
  resourceOccupations: OccupationBlock[];
  selectedCount: number;
  scheduledCount: number;
  heavyCount: number;
  requiredMinutes: number;
  scheduledMinutes: number;
  draftWindowMinutes: number;
  fitsDraftWindow: boolean;
  blockedAtStart: boolean;
}

interface EvaluateWorkOrderDraftArgs {
  draft: WorkOrderDraft;
  editingId?: string | null;
  faults: Fault[];
  inspections: Inspection[];
  switches: Switch[];
  yards: Yard[];
  workOrders: WorkOrder[];
  horizonDays?: number;
}

interface BusyInterval {
  start: number;
  end: number;
  orders: WorkOrder[];
}

interface SchedulePlan {
  scheduled: ScheduledFault[];
  deferred: DeferredFault[];
  cursor: number;
  unscheduledHeavy: ScheduleFaultContext[];
}

function severityRank(severity: FaultSeverity): number {
  if (severity === 'heavy') return 0;
  if (severity === 'medium') return 1;
  return 2;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sharedResources(
  draft: Pick<WorkOrderDraft, 'leader' | 'members' | 'machines'>,
  order: WorkOrder,
): { people: string[]; machines: string[]; leaderNames: string[] } {
  const leader = draft.leader.trim();
  const draftPeople = new Set([leader, ...draft.members.map((item) => item.trim())].filter(Boolean));
  const orderPeople = new Set([order.leader, ...order.members].filter(Boolean));
  const people = [...draftPeople].filter((person) => orderPeople.has(person));
  const machines = draft.machines.filter((machine) => order.machines.includes(machine));
  const leaderNames = leader && (order.leader === leader || order.members.includes(leader)) ? [leader] : [];
  return { people, machines, leaderNames };
}

function toOccupationBlock(order: WorkOrder, shared: ReturnType<typeof sharedResources>): OccupationBlock {
  return {
    id: order.id,
    code: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    leaderNames: shared.leaderNames,
    people: unique(shared.people),
    machines: unique(shared.machines),
  };
}

/** 找出指定时间窗内，与草稿负责人 / 人员 / 机具重叠的已保存作业单 */
export function findResourceOccupations(
  draft: Pick<WorkOrderDraft, 'windowStart' | 'windowEnd' | 'leader' | 'members' | 'machines'>,
  workOrders: WorkOrder[],
  editingId?: string | null,
): OccupationBlock[] {
  return workOrders
    .filter((order) => order.id !== editingId && isOverlap(draft, order))
    .map((order) => ({ order, shared: sharedResources(draft, order) }))
    .filter((item) => item.shared.people.length > 0 || item.shared.machines.length > 0)
    .map((item) => toOccupationBlock(item.order, item.shared));
}

function buildFaultContexts(args: {
  faults: Fault[];
  inspections: Inspection[];
  switches: Switch[];
  yards: Yard[];
}): Map<string, ScheduleFaultContext> {
  const inspectionMap = new Map(args.inspections.map((item) => [item.id, item]));
  const switchMap = new Map(args.switches.map((item) => [item.id, item]));
  const yardMap = new Map(args.yards.map((item) => [item.id, item]));

  return new Map(
    args.faults.map((fault) => {
      const inspection = inspectionMap.get(fault.inspectionId);
      const switchRow = inspection ? switchMap.get(inspection.switchId) : undefined;
      const yard = switchRow ? yardMap.get(switchRow.yardId) : undefined;
      return [
        fault.id,
        {
          id: fault.id,
          severity: fault.severity,
          yardId: switchRow?.yardId ?? 'unknown',
          yardName: yard?.name ?? '未知站场',
          switchId: switchRow?.id ?? 'unknown',
          switchCode: switchRow?.code ?? '-',
          inspectionId: inspection?.id ?? 'unknown',
          inspectionDate: inspection?.date ?? '-',
        },
      ];
    }),
  );
}

function sortFaults(faults: ScheduleFaultContext[]): ScheduleFaultContext[] {
  const yardHighest = new Map<string, FaultSeverity>();
  for (const fault of faults) {
    const current = yardHighest.get(fault.yardId);
    if (!current || severityRank(fault.severity) < severityRank(current)) {
      yardHighest.set(fault.yardId, fault.severity);
    }
  }

  return [...faults].sort((a, b) => {
    const severityDiff = severityRank(a.severity) - severityRank(b.severity);
    if (severityDiff !== 0) return severityDiff;

    const yardRankDiff =
      severityRank(yardHighest.get(a.yardId) ?? 'light') - severityRank(yardHighest.get(b.yardId) ?? 'light');
    if (yardRankDiff !== 0) return yardRankDiff;

    return (
      a.yardName.localeCompare(b.yardName, 'zh-Hans-CN') ||
      a.switchCode.localeCompare(b.switchCode, 'zh-Hans-CN') ||
      a.id.localeCompare(b.id)
    );
  });
}

function buildBusyIntervals(
  draft: WorkOrderDraft,
  workOrders: WorkOrder[],
  editingId: string | null,
  anchor: number,
  horizonEnd: number,
): BusyInterval[] {
  const intervals: BusyInterval[] = [];
  for (const order of workOrders) {
    if (order.id === editingId) continue;
    const shared = sharedResources(draft, order);
    if (shared.people.length === 0 && shared.machines.length === 0) continue;

    const start = Math.max(parseDateTime(order.windowStart), anchor);
    const end = Math.min(parseDateTime(order.windowEnd), horizonEnd);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) continue;
    intervals.push({ start, end, orders: [order] });
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BusyInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      last.orders.push(...interval.orders);
    } else {
      merged.push({ ...interval, orders: [...interval.orders] });
    }
  }
  return merged;
}

function buildFreeGaps(anchor: number, horizonEnd: number, intervals: BusyInterval[]): FeasibleWindow[] {
  const gaps: FeasibleWindow[] = [];
  let cursor = anchor;

  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start <= cursor) {
      cursor = Math.max(cursor, interval.end);
      continue;
    }
    if (cursor < interval.start) {
      gaps.push({
        start: formatTimestamp(cursor),
        end: formatTimestamp(interval.start),
        minutes: Math.round((interval.start - cursor) / MINUTE_MS),
      });
    }
    cursor = interval.end;
  }

  if (cursor < horizonEnd) {
    gaps.push({
      start: formatTimestamp(cursor),
      end: formatTimestamp(horizonEnd),
      minutes: Math.round((horizonEnd - cursor) / MINUTE_MS),
    });
  }
  return gaps;
}

function scheduleWithin(gap: FeasibleWindow, faults: ScheduleFaultContext[]): SchedulePlan {
  let cursor = parseDateTime(gap.start);
  const gapEnd = parseDateTime(gap.end);
  const scheduled: ScheduledFault[] = [];
  const deferred: DeferredFault[] = [];
  let unscheduledHeavy: ScheduleFaultContext[] = [];
  const heavyFaults = faults.filter((item) => item.severity === 'heavy');
  const mediumFaults = faults.filter((item) => item.severity === 'medium');
  const lightFaults = faults.filter((item) => item.severity === 'light');
  const groups: Array<{ faults: ScheduleFaultContext[]; overflowReason: DeferredReason }> = [
    { faults: heavyFaults, overflowReason: 'heavy-overflow' },
    { faults: mediumFaults, overflowReason: 'medium-overflow' },
    { faults: lightFaults, overflowReason: 'light-overflow' },
  ];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    for (const fault of group.faults) {
      const minutes = FAULT_SCHEDULE_MINUTES[fault.severity];
      const end = cursor + minutes * MINUTE_MS;

      if (end <= gapEnd) {
        scheduled.push({ ...fault, start: formatTimestamp(cursor), end: formatTimestamp(end), minutes });
        cursor = end;
        continue;
      }

      if (fault.severity === 'heavy') {
        unscheduledHeavy = group.faults.slice(group.faults.indexOf(fault));
        return { scheduled, deferred, cursor, unscheduledHeavy };
      }

      // 当前等级放不下时，本级剩余病害和后续更低等级全部延后，保证重级先排。
      const remainingFaults = groups.slice(groupIndex).flatMap((item) => item.faults);
      const remainingStart = remainingFaults.findIndex((item) => item.id === fault.id);
      for (const remaining of remainingFaults.slice(remainingStart)) {
        deferred.push({ ...remaining, reason: group.overflowReason });
      }
      return { scheduled, deferred, cursor, unscheduledHeavy };
    }
  }

  return { scheduled, deferred, cursor, unscheduledHeavy };
}

function planWindow(plan: SchedulePlan, start: string): FeasibleWindow | null {
  const last = plan.scheduled[plan.scheduled.length - 1];
  if (!last) return null;
  return {
    start,
    end: last.end,
    minutes: Math.round((parseDateTime(last.end) - parseDateTime(start)) / MINUTE_MS),
  };
}

function toRecommendedPlan(gap: FeasibleWindow, plan: SchedulePlan): RecommendedPlan {
  return {
    window: planWindow(plan, gap.start) ?? gap,
    scheduledIds: plan.scheduled.map((item) => item.id),
    deferredFaults: plan.deferred,
  };
}

function invalidResult(
  error: string,
  draft: WorkOrderDraft,
  resourceOccupations: OccupationBlock[],
): FeasibilityResult {
  return {
    status: 'blocked',
    canSave: false,
    error,
    currentGap: null,
    suggestedWindow: null,
    recommendedPlan: null,
    laterPlan: null,
    scheduledFaults: [],
    deferredFaults: [],
    blockingOccupations: resourceOccupations,
    resourceOccupations,
    selectedCount: draft.faultIds.length,
    scheduledCount: 0,
    heavyCount: 0,
    requiredMinutes: 0,
    scheduledMinutes: 0,
    draftWindowMinutes: 0,
    fitsDraftWindow: false,
    blockedAtStart: false,
  };
}

/** 评估当前作业单草稿在现有人员、机具占用下的连续可行时段与排法 */
export function evaluateWorkOrderDraft(args: EvaluateWorkOrderDraftArgs): FeasibilityResult {
  const {
    draft,
    editingId = null,
    faults,
    inspections,
    switches,
    yards,
    workOrders,
    horizonDays = DEFAULT_HORIZON_DAYS,
  } = args;

  const resourceOccupations = findResourceOccupations(draft, workOrders, editingId);
  const anchor = parseDateTime(draft.windowStart);
  const draftEnd = parseDateTime(draft.windowEnd);

  if (Number.isNaN(anchor) || Number.isNaN(draftEnd) || draftEnd <= anchor) {
    return invalidResult('天窗止必须晚于天窗起', draft, resourceOccupations);
  }
  if (!draft.leader.trim()) {
    return invalidResult('请选择负责人', draft, resourceOccupations);
  }

  const contextMap = buildFaultContexts({ faults, inspections, switches, yards });
  const selectedFaults = draft.faultIds
    .map((id) => contextMap.get(id))
    .filter((item): item is ScheduleFaultContext => Boolean(item));

  if (selectedFaults.length === 0) {
    return invalidResult('请至少关联一处病害', draft, resourceOccupations);
  }
  if (selectedFaults.length !== draft.faultIds.length) {
    return invalidResult('部分病害缺少巡检、道岔或站场上下文', draft, resourceOccupations);
  }

  const horizonEnd = anchor + horizonDays * 24 * 60 * MINUTE_MS;
  const busyIntervals = buildBusyIntervals(draft, workOrders, editingId, anchor, horizonEnd);
  const gaps = buildFreeGaps(anchor, horizonEnd, busyIntervals);
  const currentGap = gaps[0] ?? null;
  const sortedFaults = sortFaults(selectedFaults);
  const heavyCount = selectedFaults.filter((item) => item.severity === 'heavy').length;
  const requiredMinutes = sortedFaults.reduce(
    (sum, item) => sum + FAULT_SCHEDULE_MINUTES[item.severity],
    0,
  );
  const draftWindowMinutes = Math.round((draftEnd - anchor) / MINUTE_MS);

  if (!currentGap) {
    return {
      status: 'blocked',
      canSave: false,
      error: `未来 ${horizonDays} 天内没有可安排的连续空闲时段`,
      currentGap: null,
      suggestedWindow: null,
      recommendedPlan: null,
      laterPlan: null,
      scheduledFaults: [],
      deferredFaults: [],
      blockingOccupations: resourceOccupations,
      resourceOccupations,
      selectedCount: selectedFaults.length,
      scheduledCount: 0,
      heavyCount,
      requiredMinutes,
      scheduledMinutes: 0,
      draftWindowMinutes,
      fitsDraftWindow: false,
      blockedAtStart: true,
    };
  }

  const currentPlan = scheduleWithin(currentGap, sortedFaults);
  const blockedAtStart = parseDateTime(currentGap.start) > anchor;
  const heavyOverflow = currentPlan.unscheduledHeavy.length > 0;
  const blocked = blockedAtStart || heavyOverflow;

  let bestFit: { gap: FeasibleWindow; plan: SchedulePlan } | null = null;
  for (const gap of gaps) {
    const plan = scheduleWithin(gap, sortedFaults);
    if (plan.unscheduledHeavy.length > 0) continue;
    if (!bestFit || plan.scheduled.length > bestFit.plan.scheduled.length) {
      bestFit = { gap, plan };
    }
  }
  const earliestHeavyFit = bestFit
    ? gaps
        .map((gap) => ({ gap, plan: scheduleWithin(gap, sortedFaults) }))
        .find((item) => item.plan.unscheduledHeavy.length === 0) ?? null
    : null;

  // 只有后续间隙能多排（例如当前间隙容不下的中/轻级）时才作为改期建议。
  const laterFit =
    bestFit && bestFit.gap.start !== currentGap.start && bestFit.plan.scheduled.length > currentPlan.scheduled.length
      ? bestFit
      : null;
  const heavyFit = blocked ? earliestHeavyFit : null;

  const blockingOccupations: OccupationBlock[] = [];

  if (blockedAtStart) {
    for (const order of workOrders) {
      if (order.id === editingId) continue;
      const start = parseDateTime(order.windowStart);
      const end = parseDateTime(order.windowEnd);
      if (start <= anchor && end > anchor) {
        const shared = sharedResources(draft, order);
        if (shared.people.length > 0 || shared.machines.length > 0) {
          blockingOccupations.push(toOccupationBlock(order, shared));
        }
      }
    }
  }

  if (heavyOverflow) {
    const remainingHeavyMinutes = currentPlan.unscheduledHeavy.reduce(
      (sum, item) => sum + FAULT_SCHEDULE_MINUTES[item.severity],
      0,
    );
    const desiredStart = currentPlan.cursor;
    const desiredEnd = desiredStart + remainingHeavyMinutes * MINUTE_MS;
    for (const order of workOrders) {
      if (order.id === editingId) continue;
      const start = parseDateTime(order.windowStart);
      const end = parseDateTime(order.windowEnd);
      if (start < desiredEnd && end > desiredStart) {
        const shared = sharedResources(draft, order);
        if (shared.people.length > 0 || shared.machines.length > 0) {
          blockingOccupations.push(toOccupationBlock(order, shared));
        }
      }
    }
  }

  const deduplicatedBlocks = new Map<string, OccupationBlock>();
  for (const block of blockingOccupations) {
    deduplicatedBlocks.set(block.id, block);
  }

  const scheduledEnd = currentPlan.scheduled[currentPlan.scheduled.length - 1]?.end;
  const scheduledEndMs = scheduledEnd ? parseDateTime(scheduledEnd) : Number.NaN;
  const fitsDraftWindow =
    !blocked && currentPlan.deferred.length === 0 && parseDateTime(currentGap.start) === anchor && scheduledEndMs <= draftEnd;
  const suggestedWindow = blocked ? null : planWindow(currentPlan, currentGap.start);
  const status: FeasibilityStatus = blocked
    ? 'blocked'
    : currentPlan.deferred.length > 0
      ? 'deferred'
      : 'ready';
  const scheduledMinutes = currentPlan.scheduled.reduce((sum, item) => sum + item.minutes, 0);

  return {
    status,
    canSave: !blocked && currentPlan.deferred.length === 0 && fitsDraftWindow,
    error: '',
    currentGap,
    suggestedWindow,
    recommendedPlan: blocked && heavyFit ? toRecommendedPlan(heavyFit.gap, heavyFit.plan) : null,
    laterPlan: !blocked && laterFit ? toRecommendedPlan(laterFit.gap, laterFit.plan) : null,
    scheduledFaults: currentPlan.scheduled,
    deferredFaults: currentPlan.deferred,
    blockingOccupations: [...deduplicatedBlocks.values()],
    resourceOccupations,
    selectedCount: selectedFaults.length,
    scheduledCount: currentPlan.scheduled.length,
    heavyCount,
    requiredMinutes,
    scheduledMinutes,
    draftWindowMinutes,
    fitsDraftWindow,
    blockedAtStart,
  };
}

function formatOccupation(block: OccupationBlock): string {
  const resources = [
    block.leaderNames.length > 0 ? `负责人 ${block.leaderNames.join('、')}` : '',
    block.people.filter((person) => !block.leaderNames.includes(person)).length > 0
      ? `人员 ${block.people.filter((person) => !block.leaderNames.includes(person)).join('、')}`
      : '',
    block.machines.length > 0 ? `机具 ${block.machines.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return `${block.code}（${block.windowStart} ~ ${block.windowEnd.slice(-5)}，${resources}）`;
}

/** 生成保存拦截提示；canSave 为 true 时返回 null */
export function feasibilityBlockReason(result: FeasibilityResult, horizonDays = DEFAULT_HORIZON_DAYS): string | null {
  if (result.canSave) return null;
  if (result.error) return result.error;

  if (result.status === 'blocked') {
    if (result.blockingOccupations.length > 0) {
      return `重级病害连续时段不足，保存被挡住：${result.blockingOccupations.map(formatOccupation).join('；')}`;
    }
    return `未来 ${horizonDays} 天内找不到可容纳全部重级病害的连续时段，请调整负责人、人员或机具`;
  }

  if (result.deferredFaults.length > 0) {
    const labels = result.deferredFaults.map((item) => `${item.yardName} ${item.switchCode}`).join('、');
    return `当前连续可行时段需先延后 ${result.deferredFaults.length} 处中/轻级病害：${labels}`;
  }

  if (!result.fitsDraftWindow && result.suggestedWindow) {
    return `当前天窗时长不足，建议调整为 ${result.suggestedWindow.start} ~ ${result.suggestedWindow.end.slice(-5)}`;
  }

  return '当前草稿暂不可保存，请调整时间、负责人、人员或机具';
}
