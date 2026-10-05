/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  putFaults,
  putWorkOrder,
  removeWorkOrder,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import {
  findMachineConflicts,
  findMemberConflicts,
  nowDateTime,
  windowMinutes,
} from '../utils/window';
import {
  evaluateDraftSchedule,
  scheduledFaultIds,
} from '../utils/schedule';
import { emitChange } from '../utils/events';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  inspections: [],
  switches: [],
  yards: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

function evaluateOrderDraft(
  state: WorkOrderStateSlice,
  draft: WorkOrderDraft,
  editingOrderId?: string | null,
) {
  return evaluateDraftSchedule({
    windowStart: draft.windowStart,
    windowEnd: draft.windowEnd,
    leader: draft.leader,
    members: draft.members,
    machines: draft.machines,
    faultIds: draft.faultIds,
    editingOrderId,
    workOrders: state.workOrders,
    faults: state.faults,
    inspections: state.inspections,
    switches: state.switches,
    yards: state.yards,
  });
}

function blockedOrderMessage(codes: string[], schedule: ReturnType<typeof evaluateOrderDraft>): string {
  if (codes.length > 0) {
    return `重级病害连续时段不足，被 ${codes.join('、')} 的负责人 / 人员 / 机具占用挡住，请调整资源或时段`;
  }
  return schedule.scheduledItems.length === 0
    ? '当前连续时段连首处病害都放不下，请调大天窗、更换资源或延后其它病害'
    : '当前连续时段放不下重级病害，请调大天窗或延后其它病害';
}

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, inspections, switches, yards] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
    ]);
    return { workOrders, faults, inspections, switches, yards };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 新建作业单：仅保存当前草稿可行时段内能连续排入的病害，并回传资源冲突编号 */
export const createWorkOrder = createAsyncThunk<
  {
    created: boolean;
    resourceConflicts: string[];
    scheduledFaultIds: string[];
    postponedFaultIds: string[];
  },
  WorkOrderDraft,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const schedule = evaluateOrderDraft(state, draft);
    if (!schedule.canSave) {
      const blockerCodes = schedule.currentBlockers.map((item) => item.code);
      return rejectWithValue(
        blockerCodes.length > 0
          ? blockedOrderMessage(blockerCodes, schedule)
          : '当前连续时段放不下重级病害，请调大天窗或延后其它病害',
      );
    }

    const feasibleFaultIds = scheduledFaultIds(schedule);

    await putWorkOrder({
      id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      code: draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1),
      faultIds: feasibleFaultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      state: 'planned',
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    emitChange();
    return {
      created: true,
      resourceConflicts: schedule.currentBlockers.map((item) => item.code),
      scheduledFaultIds: feasibleFaultIds,
      postponedFaultIds: schedule.postponedItems.map((item) => item.id),
    };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新建作业单失败');
  }
});

export const updateWorkOrder = createAsyncThunk<
  { postponedCount: number },
  { id: string; draft: WorkOrderDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/update', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return { postponedCount: 0 };
    const schedule = evaluateOrderDraft(state, draft, id);
    if (!schedule.canSave) {
      const blockerCodes = schedule.currentBlockers.map((item) => item.code);
      return rejectWithValue(
        blockerCodes.length > 0
          ? blockedOrderMessage(blockerCodes, schedule)
          : '当前连续时段放不下重级病害，请调大天窗或延后其它病害',
      );
    }

    const feasibleFaultIds = scheduledFaultIds(schedule);
    await putWorkOrder({
      ...existing,
      code: draft.code.trim(),
      faultIds: feasibleFaultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { postponedCount: schedule.postponedItems.length };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新作业单失败');
  }
});

/**
 * 推进作业单状态。
 * 推进到「已完成」时，把关联病害批量置为已销号（回写销号）。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; next: WorkOrderState },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/advance', async ({ id, next }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return { state: next, solvedCount: 0 };
    const allowed = WORK_ORDER_STATE_FLOW[existing.state];
    if (!allowed.includes(next)) return { state: existing.state, solvedCount: 0 };

    let solvedCount = 0;
    if (next === 'done') {
      const related = state.faults.filter(
        (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
      );
      if (related.length > 0) {
        await putFaults(
          related.map((item) => ({ ...item, state: 'solved' as const, solvedAt: nowDateTime() })),
        );
        solvedCount = related.length;
      }
    }
    await putWorkOrder({
      ...existing,
      state: next,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { state: next, solvedCount };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '推进作业单失败');
  }
});

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突与未销号数量 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter((item) => item.id !== order.id);
      const overlappingOrders = others.filter(
        (item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd,
      );
      const resourceConflicts = overlappingOrders.filter(
        (item) =>
          item.leader === order.leader ||
          item.members.includes(order.leader) ||
          order.members.includes(item.leader) ||
          item.members.some((member) => order.members.includes(member)) ||
          item.machines.some((machine) => order.machines.includes(machine)),
      );
      const conflictCodes = resourceConflicts.map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
  };
}
