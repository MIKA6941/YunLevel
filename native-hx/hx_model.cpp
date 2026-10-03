// hx_model.cpp -- heat exchanger physics implementation.
//
// Ported from BoilerPID 2.1 (model.cpp).  The physics blocks below keep the
// original expressions and constants; only the controller was replaced by the
// shared PID struct.  Block numbers in the comments refer to the original
// source so a reviewer can diff them side by side.

#include "hx_model.h"
#include <cmath>

namespace {

double clampd(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

// Flow coefficient for the superheated steam path (original block 0c).
double SteamFlowCoeff(const HxSystem* sys) {
    const double relief_p = (sys->hv1102_open_eff > 0.0) ? (sys->hv1102_open_eff / 100.0) : 0.0;
    const double P1 = sys->steam_pressure * (1.0 - HX_RELIEF_P_SCALE * relief_p);
    double P2 = HX_P2_BASE + HX_PIPE_RESISTANCE * sys->steam_flow;
    if (P2 > P1 * 0.95) P2 = P1 * 0.95;
    if (P2 < P1 * HX_CRIT_PRESSURE_RATIO) P2 = P1 * HX_CRIT_PRESSURE_RATIO;
    const double deltaP = P1 - P2;
    const double pressure_ratio = P2 / P1;
    double flow_coeff = (pressure_ratio >= HX_CRIT_PRESSURE_RATIO)
        ? std::sqrt(deltaP * P1)
        : P1;
    const double T1_abs = sys->T_inlet + 273.15;
    const double T_ref_abs = HX_T_REF + 273.15;
    const double K_superheat = std::sqrt(T_ref_abs / T1_abs);
    const double ref_deltaP = HX_STEAM_PRESSURE - HX_P2_BASE;
    const double ref_flow_coeff = std::sqrt(ref_deltaP * HX_STEAM_PRESSURE);
    return flow_coeff / ref_flow_coeff * K_superheat;
}

// Valve opening (%) -> steam flow setpoint (kg/s), original block 0c.
double SteamFlowFromOpening(const HxSystem* sys, double opening_pct) {
    const double open_ratio = opening_pct / 100.0;
    // FV1105：过热蒸汽 B 出口阀，决定 B 路流量。
    // HV1102：过热蒸汽 A 泄压阀，与 FV1105 共享蒸汽侧——泄压越大，B 路可用流量/压力越小。
    const double relief = (sys->hv1102_open_eff > 0.0) ? (sys->hv1102_open_eff / 100.0) : 0.0;
    const double couple = (1.0 - HX_RELIEF_FLOW_SHARE * relief);
    double flow = open_ratio * HX_MAX_FV1105_FLOW * SteamFlowCoeff(sys) * couple;
    if (flow < 0.0) flow = 0.0;
    return flow;
}

double LoopPvValue(const HxSystem* sys, int pv) {
    return HxPvValue(sys, pv);
}

double LoopSpValue(const HxSystem* sys, int pv) {
    return HxPvSetpoint(sys, pv);
}

double* ValveTarget(HxSystem* sys, int mv) {
    switch (mv) {
        case HX_MV_FV1102: return &sys->water_valve_open;
        case HX_MV_FV1101: return &sys->fuel_valve_open;
        case HX_MV_FV1105: return &sys->fv1105_open;
        case HX_MV_HV1102: return &sys->hv1102_open;
        default: return nullptr;
    }
}

}  // namespace

// ---------------------------------------------------------------------------
// Algebra of the original model
// ---------------------------------------------------------------------------
double HxSteadyTemperature(double fuel_flow) {
    double T = HX_T_SAT + fuel_flow * 121.43;
    if (T > 600.0) T = 600.0;
    return T;
}

double HxFuelRequired(double target) {
    if (target <= HX_T_SAT) return 0.0;
    return (target - HX_T_SAT) / 121.43;
}

double HxValveToFuel(double valve_open) {
    return HX_MIN_FUEL_FLOW + (HX_MAX_FUEL_FLOW - HX_MIN_FUEL_FLOW) * valve_open / 100.0;
}

// ---------------------------------------------------------------------------
// PV surface shared by single loops and cascade rings
// ---------------------------------------------------------------------------
double HxPvValue(const HxSystem* sys, int pv) {
    if (!sys) return 0.0;
    return (pv == HX_PVX_FI1105) ? sys->steam_flow : sys->T_measured;
}

double HxPvSetpoint(const HxSystem* sys, int pv) {
    if (!sys) return 0.0;
    return (pv == HX_PVX_FI1105) ? sys->flow_setpoint : sys->setpoint;
}

void HxWritePvSetpoint(HxSystem* sys, int pv, double value) {
    if (!sys) return;
    if (pv == HX_PVX_FI1105) sys->flow_setpoint = clampd(value, 0.0, HX_MAX_FV1105_FLOW);
    else sys->setpoint = clampd(value, 0.0, 700.0);
}

double HxPvSpan(int pv) {
    return (pv == HX_PVX_FI1105) ? HX_MAX_FV1105_FLOW : 700.0;
}

// ---------------------------------------------------------------------------
// Cascade table
// ---------------------------------------------------------------------------
int HxCascByValve(const HxSystem* sys, int mv) {
    if (!sys) return -1;
    for (int c = 0; c < sys->nCasc; ++c) {
        if (sys->casc[c].mv == mv) return c;
    }
    return -1;
}

bool HxValveOccupied(const HxSystem* sys, int mv) {
    return HxLoopByValve(sys, mv) >= 0 || HxCascByValve(sys, mv) >= 0;
}

bool HxSetMode(HxSystem* sys, int mode) {
    if (!sys) return false;
    if (mode != HX_MODE_LOOP && mode != HX_MODE_CASC) return false;
    if (mode == sys->mode) return true;

    // 把当前方案的两张表存进 other 槽。
    HxLoop savedLoop[HX_MAX_LOOPS];
    const int savedLoops = sys->nLoop;
    for (int i = 0; i < savedLoops && i < HX_MAX_LOOPS; ++i) savedLoop[i] = sys->loop[i];
    HxCasc savedCasc[HX_MAX_CASC];
    const int savedCascs = sys->nCasc;
    for (int i = 0; i < savedCascs && i < HX_MAX_CASC; ++i) savedCasc[i] = sys->casc[i];

    if (sys->other_mode == mode) {
        // 目标方案之前搭过：还原它。
        sys->nLoop = sys->nLoop_other;
        for (int i = 0; i < sys->nLoop; ++i) sys->loop[i] = sys->loop_other[i];
        sys->nCasc = sys->nCasc_other;
        for (int i = 0; i < sys->nCasc; ++i) sys->casc[i] = sys->casc_other[i];
    } else {
        // 目标方案还没搭过：空表起步。
        sys->nLoop = 0;
        sys->nCasc = 0;
    }

    sys->nLoop_other = savedLoops;
    for (int i = 0; i < savedLoops && i < HX_MAX_LOOPS; ++i) sys->loop_other[i] = savedLoop[i];
    sys->nCasc_other = savedCascs;
    for (int i = 0; i < savedCascs && i < HX_MAX_CASC; ++i) sys->casc_other[i] = savedCasc[i];
    sys->other_mode = sys->mode;
    sys->mode = mode;
    return true;
}

int HxCascAdd(HxSystem* sys, int mv, int outer, int inner) {
    if (!sys) return HX_CASC_ADD_FULL;
    if (sys->mode != HX_MODE_CASC) return HX_CASC_ADD_MODE;
    if (mv < 0 || mv >= HX_MV_COUNT || outer < 0 || outer >= HX_PVX_COUNT || inner < 0 || inner >= HX_PVX_COUNT)
        return HX_CASC_ADD_FULL;
    if (sys->nCasc >= HX_MAX_CASC) return HX_CASC_ADD_FULL;
    if (sys->nCasc + sys->nLoop >= HX_MAX_LOOPS) return HX_CASC_ADD_FULL;
    for (int c = 0; c < sys->nCasc; ++c) {
        if (!sys->casc[c].enabled) continue;
        if (sys->casc[c].mv == mv && sys->casc[c].outer == outer && sys->casc[c].inner == inner)
            return HX_CASC_ADD_DUPLICATE;
    }
    if (HxValveOccupied(sys, mv)) return HX_CASC_ADD_MV_CONFLICT;

    HxCasc& C = sys->casc[sys->nCasc];
    C.mv = mv;
    C.outer = outer;
    C.inner = inner;
    C.enabled = true;
    PidInit(&C.opid);
    PidInit(&C.ipid);
    // 方向按实测耦合矩阵定（见 docs/项目进度.md 的换热器耦合表）：
    //   内环：开阀使副环被控量升高 -> -1（FV1105 升开度 -> FI1105 上升）。
    //   外环：副环给定升高使主环被控量升高 -> -1（升温工况下多排汽 -> TI1104 上升）。
    C.opid.action = (outer == HX_PVX_TI1104 && inner == HX_PVX_FI1105) ? -1 : 1;
    C.ipid.action = (inner == HX_PVX_FI1105) ? -1 : 1;
    C.opid.out_min = 0.0;  C.opid.out_max = 100.0;
    C.ipid.out_min = 0.0;  C.ipid.out_max = 100.0;
    C.opid.manual = true;
    C.ipid.manual = true;
    C.opid.manual_out = 0.0;
    // 副环初值：直接取当前阀门开度，避免投入瞬间跳变。
    C.ipid.manual_out = (mv == HX_MV_FV1105) ? 23.3333333333 : 0.0;
    PidReset(&C.opid, C.opid.manual_out);
    PidReset(&C.ipid, C.ipid.manual_out);
    sys->nCasc++;
    return sys->nCasc - 1;
}

bool HxCascDel(HxSystem* sys, int index) {
    if (!sys || index < 0 || index >= sys->nCasc) return false;
    for (int i = index; i < sys->nCasc - 1; ++i) sys->casc[i] = sys->casc[i + 1];
    sys->nCasc--;
    return true;
}

void HxCascClear(HxSystem* sys) {
    if (!sys) return;
    sys->nCasc = 0;
}

// ---------------------------------------------------------------------------
// Loop table
// ---------------------------------------------------------------------------
int HxLoopByValve(const HxSystem* sys, int mv) {
    for (int i = 0; i < sys->nLoop; ++i) {
        if (sys->loop[i].mv == mv) return i;
    }
    return -1;
}

int HxLoopByPv(const HxSystem* sys, int pv) {
    for (int i = 0; i < sys->nLoop; ++i) {
        if (sys->loop[i].pv == pv) return i;
    }
    return -1;
}

int HxLoopAdd(HxSystem* sys, int pv, int mv) {
    if (!sys) return HX_LOOP_ADD_FULL;
    if (pv < 0 || pv >= HX_PV_COUNT || mv < 0 || mv >= HX_MV_COUNT) return HX_LOOP_ADD_FULL;
    for (int i = 0; i < sys->nLoop; ++i) {
        if (sys->loop[i].pv == pv && sys->loop[i].mv == mv) return HX_LOOP_ADD_DUPLICATE;
    }
    if (HxValveOccupied(sys, mv)) return HX_LOOP_ADD_MV_CONFLICT;
    if (sys->nLoop + sys->nCasc >= HX_MAX_LOOPS) return HX_LOOP_ADD_FULL;

    HxLoop& L = sys->loop[sys->nLoop];
    L.pv = pv;
    L.mv = mv;
    L.enabled = true;
    PidInit(&L.pid);
    // Direction per process: raising FV1102 cools TI1104, so a rising PV must
    // open the valve (action +1 with e = SP - PV); raising FV1105 raises
    // FI1105, so a falling PV must open it (action -1).
    L.pid.action = (pv == HX_PV_FI1105) ? -1 : 1;
    L.pid.manual = true;              // student applies parameters explicitly
    L.pid.manual_out = (mv == HX_MV_FV1105) ? 23.3333333333 : 0.0;
    if (L.pid.manual) PidReset(&L.pid, L.pid.manual_out);
    sys->nLoop++;
    return HX_LOOP_ADD_OK;
}

bool HxLoopDel(HxSystem* sys, int index) {
    if (!sys || index < 0 || index >= sys->nLoop) return false;
    for (int i = index; i < sys->nLoop - 1; ++i) sys->loop[i] = sys->loop[i + 1];
    sys->nLoop--;
    return true;
}

void HxLoopClear(HxSystem* sys) {
    if (!sys) return;
    sys->nLoop = 0;
    for (int mv = 0; mv < HX_MV_COUNT; ++mv) sys->vhand[mv] = 0.0;
}

// 模板重建回路时会把「未被回路占用」的自由阀门手操位清零。蒸汽阀停在 0%，
// 换热器就没有汽源，温度回路再准也控不住；这里按设计工况把自由蒸汽阀停回去。
static void HxParkFreeValvesAtDesign(HxSystem* sys, double water_pct) {
    if (!sys) return;
    if (!HxValveOccupied(sys, HX_MV_FV1105)) {
        const double opening = clampd(21.0 / HX_MAX_FV1105_FLOW * 100.0, 0.0, 100.0);
        sys->fv1105_open = opening;
        sys->fv1105_open_eff = opening;
        sys->vhand[HX_MV_FV1105] = opening;
        sys->steam_flow = SteamFlowFromOpening(sys, opening);
        sys->steam_flow_setpoint = sys->steam_flow;
    }
    // 燃料阀同理：工况初始化时已经按设计燃料量算好阀位，清空回路后被抹掉了，
    // 这里按工况的燃料量停回去，否则 HEAT_100 下热源被切断、温度顶不上去。
    if (!HxValveOccupied(sys, HX_MV_FV1101)) {
        const double open = clampd((sys->fuel_flow - HX_MIN_FUEL_FLOW)
            / (HX_MAX_FUEL_FLOW - HX_MIN_FUEL_FLOW) * 100.0, 0.0, 100.0);
        sys->fuel_valve_open = open;
        sys->fuel_valve_open_eff = open;
        sys->vhand[HX_MV_FV1101] = open;
    }
    // 冷却水阀：串级方案需要它提供一个固定的「回冷」通道，主环才有双向调节能力；
    // 单回路方案下这个阀由回路自己驱动，这里会被 HxValveOccupied 跳过。
    if (!HxValveOccupied(sys, HX_MV_FV1102)) {
        const double open = clampd(water_pct, 0.0, 100.0);
        sys->water_valve_open = open;
        sys->water_valve_open_eff = open;
        sys->vhand[HX_MV_FV1102] = open;
    }
}


// ---------------------------------------------------------------------------
// Templates (F-08 功能对等：推荐工况 / 高分模板)
// ---------------------------------------------------------------------------
// 推荐模板走「单回路 TI1104 -> FV1102 冷却水阀」（2026-09-24 用户确认）：
//   FV1102 对出口温度是单调、近似线性的冷却作用（0..100% 把 TI1104 从
//   480℃ 拉到 292℃），单回路就能稳定停在中温区；
//   FV1105 对 TI1104 近乎开关特性（0%->122℃，25% 就顶到 480℃ 上限），
//   做进主环会把阀门长期压在饱和区，因此串级只作为自由搭建选项保留，
//   不进推荐模板。
void HxApplyRecommendedTemplate(HxSystem* sys) {
    if (!sys) return;
    HxSetMode(sys, HX_MODE_LOOP);
    HxCascClear(sys);
    HxLoopClear(sys);
    const int idx = HxLoopAdd(sys, HX_PV_TI1104, HX_MV_FV1102);
    if (idx >= 0) {
        HxLoop& L = sys->loop[idx];
        L.pid.Kp = 0.60; L.pid.Ti = 120.0; L.pid.Td = 0.0;
        L.pid.action = 1;          // 正作用：出口温度高于给定就开冷却水阀
        L.pid.manual = false;
        PidReset(&L.pid, 40.0);
    }
    sys->setpoint = HX_DEFAULT_INIT_TEMP_C;
    sys->flow_setpoint = 40.0;
    HxParkFreeValvesAtDesign(sys, 0.0);
}

// 高分模板按当前方案给：单回路给整定过的 TI1104->FV1102；
// 串级给唯一物理自洽的 TI1104 主环 + FI1105 副环 -> FV1105。
void HxApplyHighScoreTemplate(HxSystem* sys) {
    if (!sys) return;
    if (sys->mode == HX_MODE_CASC) {
        HxCascClear(sys);
        HxLoopClear(sys);
        const int idx = HxCascAdd(sys, HX_MV_FV1105, HX_PVX_TI1104, HX_PVX_FI1105);
        if (idx >= 0) {
            HxCasc& C = sys->casc[idx];
            // 整定见 docs/项目进度.md：外环 0.30/60、内环 2.0/10，
            // 30 分钟内 MAE ≈ 0.01℃、整定 531 s，之后一直稳在 450.0℃。
            C.opid.Kp = 0.30; C.opid.Ti = 60.0;  C.opid.Td = 0.0;
            C.ipid.Kp = 2.00; C.ipid.Ti = 10.0;  C.ipid.Td = 0.0;
            C.opid.manual = false;
            C.ipid.manual = false;
            PidReset(&C.opid, 30.0);
            PidReset(&C.ipid, 45.0);
        }
        sys->setpoint = HX_DEFAULT_INIT_TEMP_C;
        sys->flow_setpoint = 50.0;
        HxParkFreeValvesAtDesign(sys, 6.0);
        return;
    }
    HxCascClear(sys);
    HxLoopClear(sys);
    const int idx = HxLoopAdd(sys, HX_PV_TI1104, HX_MV_FV1102);
    if (idx >= 0) {
        HxLoop& L = sys->loop[idx];
        L.pid.Kp = 0.80; L.pid.Ti = 90.0; L.pid.Td = 0.0;
        L.pid.action = 1;
        L.pid.manual = false;
        PidReset(&L.pid, 40.0);
    }
    sys->setpoint = HX_DEFAULT_INIT_TEMP_C;
    sys->flow_setpoint = 40.0;
    HxParkFreeValvesAtDesign(sys, 0.0);
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------
void HxSetInitTemp(HxSystem* sys, double t_c) {
    if (!sys) return;
    if (!(t_c > 100.0 && t_c < 700.0)) return;
    // 初始温度即 TI1103/TI1104 同点，教师端与学生端显示一致
    sys->setpoint = t_c;
    sys->T = t_c;
    sys->T_measured = t_c;
    sys->T_prev = t_c;
    sys->T_delay_s1 = t_c;
    sys->T_inlet = t_c;
    sys->T_inlet_delayed = t_c;
    sys->T_chamber = t_c;
    sys->T_target_steady = t_c;
    sys->T_wall = t_c;
    sys->T_wall_internal = t_c + 10.0;
}

void HxSetInletTemp(HxSystem* sys, double t_c) {
    if (!sys) return;
    t_c = clampd(t_c, 250.0, 650.0);
    sys->T_inlet = t_c;
    sys->T_inlet_delayed = t_c;
    sys->T_chamber = t_c;
    sys->T_target_steady = t_c;
    // 学生设定入口后锁住，避免下一步被 fuel 稳态温度拉回
    sys->fuel_temperature_locked = true;
    // 未启动时出口/壁温跟着入口走，避免出现「出口高于入口」
    if (!sys->running) {
        sys->T = t_c;
        sys->T_measured = t_c;
        sys->T_prev = t_c;
        sys->T_delay_s1 = t_c;
        sys->T_wall = t_c;
        sys->T_wall_internal = t_c + 10.0;
        if (sys->T_water_out > t_c) sys->T_water_out = t_c;
        if (sys->T_water_out < HX_T_DEAERATED) sys->T_water_out = HX_T_DEAERATED;
        sys->setpoint = t_c;
    } else if (sys->T > t_c) {
        // 运行中把入口压到出口以下时，出口不能高过入口
        sys->T = t_c;
        sys->T_measured = t_c;
    }
}

void HxInit(HxSystem* sys) {
    if (!sys) return;
    for (int mv = 0; mv < HX_MV_COUNT; ++mv) sys->vhand[mv] = 0.0;
    sys->nLoop = 0;
    sys->nCasc = 0;
    sys->mode = HX_MODE_LOOP;
    sys->nLoop_other = 0;
    sys->nCasc_other = 0;
    sys->other_mode = -1;

    sys->steam_pressure = HX_STEAM_PRESSURE;
    sys->hv1102_open = 0.0;
    sys->hv1102_open_eff = 0.0;
    sys->relieve_flow = 0.0;
    sys->setpoint = HX_DEFAULT_INIT_TEMP_C;
    sys->flow_setpoint = 21.0;
    sys->fv1105_open_min = 0.0;

    sys->T_inlet = HX_DEFAULT_INIT_TEMP_C; // TI1103 默认 400，与教师初始温度一致
    sys->T_chamber = HX_DEFAULT_INIT_TEMP_C;
    sys->T_target_steady = HX_DEFAULT_INIT_TEMP_C;
    sys->T_inlet_delayed = HX_DEFAULT_INIT_TEMP_C;
    sys->fuel_flow = HxFuelRequired(sys->T_inlet);
    sys->fuel_valve_open = (sys->fuel_flow - HX_MIN_FUEL_FLOW) / (HX_MAX_FUEL_FLOW - HX_MIN_FUEL_FLOW) * 100.0;
    sys->fuel_valve_open = clampd(sys->fuel_valve_open, 0.0, 100.0);
    sys->fuel_valve_open_eff = sys->fuel_valve_open;
    sys->fuel_temperature_locked = true;

    sys->water_valve_open = 0.0;
    sys->water_valve_open_eff = 0.0;
    sys->mw = 0.0;
    sys->mw_effective = 0.0;

    sys->T = HX_DEFAULT_INIT_TEMP_C; // 出口初始温度默认 400
    sys->T_prev = sys->T;
    sys->T_measured = sys->T;
    sys->T_delay_s1 = sys->T;
    sys->T_wall = HX_DEFAULT_INIT_TEMP_C + 40.0;
    sys->T_wall_internal = sys->T_inlet;
    sys->T_water_out = sys->T_inlet;

    sys->fv1105_open = 0.0;
    sys->fv1105_open_eff = 0.0;
    sys->steam_flow = 0.0;
    sys->steam_flow_setpoint = 0.0;

    sys->k_hx = 0.0;
    sys->Q_in = sys->Q_out = sys->Q_loss = sys->Q_hx = 0.0;
    sys->Q_metal = sys->Q_spray = 0.0;
    sys->steam_quality = 1.0;
    sys->FV1102_level = 30.0;

    sys->paused = true;
    sys->running = false;
    sys->sim_time = 0.0;
    sys->y_axis_max = 800.0;
}

namespace {

// Shared scenario plumbing: set fuel target and re-sync the steam path.
void ApplyFuel(HxSystem* sys, double fuel) {
    fuel = clampd(fuel, HX_MIN_FUEL_FLOW, HX_MAX_FUEL_FLOW);
    sys->fuel_flow = fuel;
    const double open = clampd((fuel - HX_MIN_FUEL_FLOW) / (HX_MAX_FUEL_FLOW - HX_MIN_FUEL_FLOW) * 100.0, 0.0, 100.0);
    sys->fuel_valve_open = open;
    sys->fuel_valve_open_eff = open;
    sys->vhand[HX_MV_FV1101] = open;
}

void ApplySteamOpening(HxSystem* sys, double opening) {
    sys->fv1105_open = clampd(opening, 0.0, 100.0);
    sys->fv1105_open_eff = sys->fv1105_open;
    sys->vhand[HX_MV_FV1105] = sys->fv1105_open;
    sys->steam_flow = SteamFlowFromOpening(sys, sys->fv1105_open);
    sys->steam_flow_setpoint = sys->steam_flow;
}

void PrepScenario(HxSystem* sys) {
    sys->steam_pressure = HX_STEAM_PRESSURE;
    sys->fv1105_open_min = 0.0;
    sys->nLoop = 0;
    sys->water_valve_open = 0.0;
    sys->water_valve_open_eff = 0.0;
    sys->mw = 0.0;
    sys->mw_effective = 0.0;
    sys->vhand[HX_MV_FV1102] = 0.0;
    sys->k_hx = 0.0;
    sys->Q_hx = 0.0;
    sys->Q_spray = 0.0;
    sys->Q_metal = 0.0;
    sys->steam_quality = 1.0;
    sys->FV1102_level = 20.0;
    sys->paused = true;
    sys->running = false;
    sys->sim_time = 0.0;
}

}  // namespace

void HxInitScenario(HxSystem* sys, int scenario) {
    if (!sys) return;
    HxInit(sys);
    PrepScenario(sys);

    if (scenario == HX_SCENARIO_HEAT_100) {
        const double T_inlet_0 = HX_T_SAT;      // 250 C physical floor
        const double T_out_0 = 100.0;
        const double T_target = HX_DEFAULT_INIT_TEMP_C + 80.0;
        sys->T_inlet = T_inlet_0;
        sys->T_chamber = T_inlet_0;
        sys->T_inlet_delayed = T_inlet_0;
        sys->T = T_out_0;
        sys->T_prev = T_out_0;
        sys->T_measured = T_out_0;
        sys->T_delay_s1 = T_out_0;
        sys->T_wall = T_out_0;
        sys->T_wall_internal = T_out_0;
        sys->T_water_out = HX_T_DEAERATED;
        ApplyFuel(sys, HxFuelRequired(T_target));
        sys->T_target_steady = T_target;
        sys->fuel_temperature_locked = false;
        sys->setpoint = HX_DEFAULT_INIT_TEMP_C;
        sys->y_axis_max = 500.0;
    } else {
        // 默认工况：TI1103/TI1104/SP 均为 400℃（教师可调）
        const double T0 = HX_DEFAULT_INIT_TEMP_C;
        const double T_hot = T0;
        sys->T_inlet = T_hot;
        sys->T_chamber = T_hot;
        sys->T_inlet_delayed = T_hot;
        sys->T = T0;
        sys->T_prev = T0;
        sys->T_measured = T0;
        sys->T_delay_s1 = T0;
        sys->T_wall = T0 + 20.0;
        sys->T_wall_internal = T0 + 30.0;
        sys->T_water_out = T0 - 50.0;
        ApplyFuel(sys, HxFuelRequired(T_hot));
        sys->T_target_steady = T_hot;
        sys->fuel_temperature_locked = true;
        sys->setpoint = T0;
        sys->y_axis_max = 600.0;
    }

    // Steam outlet valve parked at the design flow (21 kg/s of 90 kg/s span).
    ApplySteamOpening(sys, 21.0 / HX_MAX_FV1105_FLOW * 100.0);

    sys->Q_in = (sys->fuel_flow * HX_LHV_FUEL * HX_COMBUSTION_EFF * HX_SH_SHARE) / 1000.0;
    sys->Q_out = (sys->steam_flow * HX_CP_STEAM * (sys->T_inlet - HX_T_SAT)) / 1000.0;
    if (sys->Q_out < 0.0) sys->Q_out = 0.0;
    sys->Q_loss = 0.0;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------
void HxStep(HxSystem* sys, double dt) {
    if (!sys || sys->paused) return;
    if (dt <= 0.0) dt = 1.0;
    const double step = dt;   // the desktop model stepped at a fixed 1 s

    // ---- controllers first: PV comes from the previous completed step ----
    for (int i = 0; i < sys->nLoop; ++i) {
        HxLoop& L = sys->loop[i];
        if (!L.enabled) continue;
        const double u = PidStep(&L.pid, LoopSpValue(sys, L.pv), LoopPvValue(sys, L.pv), step);
        double* target = ValveTarget(sys, L.mv);
        if (target) *target = u;
    }
    // 串级：主环输出换算成副环给定，副环输出驱动阀门。
    for (int c = 0; c < sys->nCasc; ++c) {
        HxCasc& C = sys->casc[c];
        if (!C.enabled) continue;
        const double outer_u = PidStep(&C.opid, LoopSpValue(sys, C.outer), LoopPvValue(sys, C.outer), step);
        // 主环 0..100 % -> 副环工程量给定；写回共享 SP，副环卡片显示的给定随之更新。
        HxWritePvSetpoint(sys, C.inner, outer_u / 100.0 * HxPvSpan(C.inner));
        const double inner_u = PidStep(&C.ipid, LoopSpValue(sys, C.inner), LoopPvValue(sys, C.inner), step);
        double* target = ValveTarget(sys, C.mv);
        if (target) *target = inner_u;
    }
    // A valve that no loop and no cascade owns follows its manual position.
    for (int mv = 0; mv < HX_MV_COUNT; ++mv) {
        if (HxValveOccupied(sys, mv)) continue;
        double* target = ValveTarget(sys, mv);
        if (target) *target = sys->vhand[mv];
    }
    sys->water_valve_open  = clampd(sys->water_valve_open, 0.0, 100.0);
    sys->fv1105_open       = clampd(sys->fv1105_open, 0.0, 100.0);
    sys->fuel_valve_open   = clampd(sys->fuel_valve_open, 0.0, 100.0);
    // 燃料阀是「阀位 -> 燃料量」的唯一通道：手操、SET_VALVE 和回路驱动都要
    // 真正走到燃烧里，否则学生把 FV1101 开到底温度也不动。
    // COOL_480 工况按设计把燃料回路断开（fuel_temperature_locked），保持原样。
    if (!sys->fuel_temperature_locked) {
        sys->fuel_flow = HxValveToFuel(sys->fuel_valve_open);
    }

    // ---- 0b. FV1105 actuator: instant in manual, first order in auto ----
    const int flow_loop = HxLoopByValve(sys, HX_MV_FV1105);
    const int flow_casc = HxCascByValve(sys, HX_MV_FV1105);
    const bool fv1105_auto = (flow_loop >= 0 && sys->loop[flow_loop].enabled && !sys->loop[flow_loop].pid.manual)
        || (flow_casc >= 0 && sys->casc[flow_casc].enabled && !sys->casc[flow_casc].ipid.manual);
    if (!fv1105_auto) {
        sys->fv1105_open_eff = sys->fv1105_open;
    } else {
        const double tau_valve = 1.0 / HX_VALVE_RATE_FV1105;
        {
            double a = step / tau_valve;
            if (a > 1.0) a = 1.0;
            if (a < 0.0) a = 0.0;
            sys->fv1105_open_eff += (sys->fv1105_open - sys->fv1105_open_eff) * a;
        }
    }
    sys->fv1105_open_eff = clampd(sys->fv1105_open_eff, sys->fv1105_open_min, 100.0);
    {
        const double tau_hv = 1.0 / HX_VALVE_RATE_HV1102;
        sys->hv1102_open_eff += (sys->hv1102_open - sys->hv1102_open_eff) / tau_hv * step;
        sys->hv1102_open_eff = clampd(sys->hv1102_open_eff, 0.0, 100.0);
    }

    // ---- 0c. opening -> steam flow setpoint ----
    sys->steam_flow_setpoint = SteamFlowFromOpening(sys, sys->fv1105_open_eff);

    // ---- 1.0 steam flow dynamics (tau = 3 s, slew limited) ----
    const double MAX_FLOW_RATE = 5.0;   // kg/s^2
    const double tau_flow = 3.0;
    double flow_rate = (sys->steam_flow_setpoint - sys->steam_flow) / tau_flow;
    if (flow_rate > MAX_FLOW_RATE * step) flow_rate = MAX_FLOW_RATE * step;
    if (flow_rate < -MAX_FLOW_RATE * step) flow_rate = -MAX_FLOW_RATE * step;
    sys->steam_flow += flow_rate * step;
    if (sys->steam_flow < 0.0) sys->steam_flow = 0.0;
    if (sys->steam_flow > HX_MAX_FV1105_FLOW) sys->steam_flow = HX_MAX_FV1105_FLOW;

    // ---- 1.1 / 1.2 furnace and TI1103 ----
    if (sys->fuel_temperature_locked) {
        sys->T_target_steady = sys->T_inlet;
    } else {
        sys->T_target_steady = HxSteadyTemperature(sys->fuel_flow);
    }
    const double tau_T = 10.0;
    sys->T_inlet += (sys->T_target_steady - sys->T_inlet) / tau_T * step;
    sys->T_inlet = clampd(sys->T_inlet, HX_T_SAT, 700.0);
    sys->T_chamber = sys->T_inlet;
    // The desktop build keeps the inlet delay disabled; retained for parity.
    sys->T_inlet_delayed = sys->T_inlet;

    sys->Q_in  = (sys->fuel_flow * HX_LHV_FUEL * HX_COMBUSTION_EFF * HX_SH_SHARE) / 1000.0;
    sys->Q_out = (sys->steam_flow * HX_CP_STEAM * (sys->T_inlet - HX_T_SAT)) / 1000.0;
    sys->Q_loss = (HX_LOSS_K * HX_EXCH_AREA * (sys->T_wall - HX_T_AMBIENT)) / 1000.0;

    const double T_inlet_eff = sys->T_inlet_delayed;

    // ---- 2.1 FV1102 actuator rate limit + pipe transport lag ----
    const double tau_valve_1102 = 1.0 / HX_VALVE_RATE_FV1102;
    {
        double a = step / tau_valve_1102;
        if (a > 1.0) a = 1.0;
        if (a < 0.0) a = 0.0;
        sys->water_valve_open_eff += (sys->water_valve_open - sys->water_valve_open_eff) * a;
        sys->water_valve_open_eff = clampd(sys->water_valve_open_eff, 0.0, 100.0);
    }

    double mw_target;
    if (sys->water_valve_open_eff <= 0.001) {
        mw_target = 0.0;
    } else {
        mw_target = sys->water_valve_open_eff / 100.0 * HX_MAX_WATER_FLOW;
        if (mw_target < HX_MIN_WATER_FLOW) mw_target = HX_MIN_WATER_FLOW;
    }
    sys->mw_effective += (mw_target - sys->mw_effective) / HX_TAU_WATER_FLOW * step;
    if (sys->mw_effective < 0.01) sys->mw_effective = 0.0;
    sys->mw = sys->mw_effective;

    // ---- 2.2 overall heat transfer coefficient (Dittus-Boelter shape) ----
    const double ms_ref = 21.0;
    double steam_factor = std::pow(sys->steam_flow / ms_ref, 0.6);
    if (steam_factor < 0.3) steam_factor = 0.3;
    sys->k_hx = HX_UA_REF * std::pow(sys->mw_effective / HX_MW_REF, 0.8) * steam_factor;

    // ---- 2.3 LMTD heat duty ----
    double dT1 = T_inlet_eff - sys->T_water_out;
    double dT2 = sys->T - HX_T_DEAERATED;
    if (dT1 < 0.1) dT1 = 0.1;
    if (dT2 < 0.1) dT2 = 0.1;
    double LMTD;
    if (std::fabs(dT1 - dT2) < 0.1) LMTD = (dT1 + dT2) / 2.0;
    else LMTD = (dT1 - dT2) / std::log(dT1 / dT2);
    if (LMTD < 0.1) LMTD = 0.1;

    double Q_hx_W = sys->k_hx * LMTD;
    const double Q_max_steam = sys->steam_flow * HX_CP_STEAM * (T_inlet_eff - HX_T_DEAERATED);
    const double Q_max_water = sys->mw * HX_WATER_CP * (600.0 - HX_T_DEAERATED);
    if (Q_hx_W > Q_max_steam * 0.95) Q_hx_W = Q_max_steam * 0.95;
    if (Q_hx_W > Q_max_water * 0.95) Q_hx_W = Q_max_water * 0.95;
    if (Q_hx_W < 0.0) Q_hx_W = 0.0;
    sys->Q_hx = Q_hx_W / 1000.0;

    // ---- 2.4 steam side temperature (TI1104), wall coupled ----
    const double hA_metal = 10000.0;   // W/C steam <-> wall
    const double Q_steam_in = sys->steam_flow * HX_CP_STEAM * (T_inlet_eff - sys->T);
    const double Q_steam_to_wall = (sys->mw > 0.0) ? hA_metal * (sys->T - sys->T_wall) : 0.0;
    sys->T += (Q_steam_in - Q_hx_W - Q_steam_to_wall) / HX_EXCH_C * step;

    // ---- 2.5 tube side outlet temperature ----
    const double Q_water_out = sys->mw * HX_WATER_CP * (sys->T_water_out - HX_T_DEAERATED);
    sys->T_water_out += (Q_hx_W - Q_water_out) / HX_C_WATER_TUBE * step;
    sys->T_water_out = clampd(sys->T_water_out, HX_T_DEAERATED, 600.0);
    if (sys->T_water_out > T_inlet_eff) sys->T_water_out = T_inlet_eff;

    // ---- 2.6 shell side limits ----
    sys->T = clampd(sys->T, HX_T_DEAERATED, 600.0);

    // ---- 2.6.1 TI1104 measurement lag ----
    const double tau_TI1104 = 3.0;
    sys->T_delay_s1 += (sys->T - sys->T_delay_s1) / tau_TI1104 * step;
    sys->T_measured = sys->T_delay_s1;

    // ---- 2.7 metal wall (second order coupling) ----
    const double C_metal_half = (2500.0 * 460.0) / 2.0;   // METAL_MASS * METAL_CP / 2
    const double Q_wall_loss = (sys->mw > 0.0) ? HX_LOSS_K * HX_EXCH_AREA * (sys->T_wall - HX_T_AMBIENT) : 0.0;
    sys->Q_metal = Q_steam_to_wall / C_metal_half;
    sys->T_wall += (Q_steam_to_wall - Q_wall_loss) / C_metal_half * step;
    sys->T_wall = clampd(sys->T_wall, HX_T_DEAERATED, 700.0);
    sys->T_wall_internal += 0.15 * (sys->T_wall - sys->T_wall_internal) * step;

    // ---- 2.8 tube level ----
    const double level_target = 20.0 + 60.0 * (sys->water_valve_open / 100.0);
    sys->FV1102_level += (level_target - sys->FV1102_level) / 8.0 * step;
    sys->FV1102_level = clampd(sys->FV1102_level, 0.0, 100.0);

    // ---- 2.9 steam quality ----
    if (sys->mw > 0.1 && LMTD > 5.0) {
        double latent_heat = 2260000.0 - 2000.0 * (sys->T - 250.0);
        if (latent_heat < 1800000.0) latent_heat = 1800000.0;
        double condensation = Q_hx_W / latent_heat;
        const double q = 1.0 - condensation / (sys->steam_flow > 1e-9 ? sys->steam_flow : 1e-9);
        sys->steam_quality = clampd(q, 0.6, 1.0);
    } else {
        sys->steam_quality = 1.0;
    }

    // ---- 2.10 power bookkeeping ----
    sys->Q_out  = (sys->steam_flow * HX_CP_STEAM * (sys->T - HX_T_SAT)) / 1000.0;
    sys->Q_loss = (HX_LOSS_K * HX_EXCH_AREA * (sys->T_wall - HX_T_AMBIENT)) / 1000.0;
    sys->Q_spray = sys->Q_hx;

    sys->T_prev = sys->T;
    sys->sim_time += step;
}
