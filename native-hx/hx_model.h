#pragma once
// hx_model.h -- heat exchanger (superheated steam) physics kernel for YunLevel.
//
// Headless port of BoilerPID 2.1.  Deliberate differences from the desktop
// original, all inside this D1 core:
//   1. no <windows.h> / <gdiplus.h>; nothing GUI related is compiled here,
//   2. controller state lives in the shared PID struct from native/pid.h, so
//      both models use exactly one controller implementation and one convention
//      (Ki = 1 / Ti, Ti = inf disables the integral, Ti = 0 is rejected),
//   3. in-kernel history buffers removed -- the gateway owns curve history.
// Every algebraic and ODE expression of the original physics is reproduced
// verbatim so numbers stay comparable with the desktop build.

#include "../native/pid.h"

// ---------------------------------------------------------------------------
// Physical constants (from Bolier2.1/config.h, Windows/GDI parts dropped)
// ---------------------------------------------------------------------------
constexpr double HX_LHV_FUEL            = 42000000.0;  // J/kg diesel LHV
constexpr double HX_COMBUSTION_EFF      = 0.85;
constexpr double HX_CP_STEAM            = 2100.0;      // J/(kg*C)
constexpr double HX_CP_WATER            = 4186.0;      // J/(kg*C)
constexpr double HX_T_SAT               = 250.0;       // C saturation
constexpr double HX_T_DEAERATED         = 102.0;       // C feedwater inlet
constexpr double HX_SH_SHARE            = 0.15;        // superheater heat share
constexpr double HX_MAX_FUEL_FLOW       = 6.0;         // kg/s
constexpr double HX_MIN_FUEL_FLOW       = 0.0;         // kg/s
constexpr double HX_MAX_WATER_FLOW      = 90.0;        // kg/s
constexpr double HX_MIN_WATER_FLOW      = 0.5;         // kg/s
constexpr double HX_MAX_FV1105_FLOW     = 90.0;        // kg/s at 100 %
constexpr double HX_STEAM_PRESSURE      = 3800.0;      // kPa
constexpr double HX_STEAM_DP_RATIO      = 0.1;
constexpr double HX_SUPERHEAT_COEF      = 0.0013;
constexpr double HX_CRIT_PRESSURE_RATIO = 0.546;
constexpr double HX_VALVE_RATE_FV1105   = 3.3;         // %/s electric actuator
constexpr double HX_VALVE_RATE_FV1102   = 3.3;         // %/s
constexpr double HX_VALVE_RATE_FV1101   = 3.3;         // %/s
constexpr double HX_TAU_WATER_FLOW      = 6.0;         // s pipe transport
constexpr double HX_P2_BASE             = 3420.0;      // kPa header pressure
constexpr double HX_PIPE_RESISTANCE     = 1.0;         // kPa*s/kg
constexpr double HX_T_REF               = 480.0;       // C
constexpr double HX_T_AMBIENT           = 20.0;        // C
constexpr double HX_EXCH_AREA           = 28.0;        // m2
constexpr double HX_LOSS_K              = 15.0;        // W/(m2*C)
constexpr double HX_EXCH_C              = 1247755.0;   // J/C steam side
constexpr double HX_UA_REF              = 6000.0;      // W/C
constexpr double HX_MW_REF              = 10.0;        // kg/s
constexpr double HX_C_WATER_TUBE        = 50000.0;     // J/C
constexpr double HX_WATER_CP            = 4186.0;      // J/(kg*C)

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
// Process values (PV) -- what a loop can measure.
enum { HX_PV_TI1104 = 0, HX_PV_FI1105 = 1, HX_PV_COUNT = 2 };
// Manipulated variables (MV) -- what a loop can drive.
enum { HX_MV_FV1102 = 0, HX_MV_FV1101 = 1, HX_MV_FV1105 = 2, HX_MV_HV1102 = 3, HX_MV_COUNT = 4 };
// HV1102：过热蒸汽 A 泄压阀（压力信号预留）。与 FV1105（过热蒸汽 B 出口）共享蒸汽侧流量/压力。
constexpr double HX_VALVE_RATE_HV1102   = 3.3;         // %/s
constexpr double HX_RELIEF_P_SCALE      = 0.35;        // 全开时蒸汽侧压力系数下降比例
constexpr double HX_RELIEF_FLOW_SHARE   = 0.25;        // 全开时旁通掉的蒸汽侧流量占比
// Loop table capacity, same ceiling as the tank model.
constexpr int HX_MAX_LOOPS = 4;
constexpr int HX_MAX_CASC  = 2;      // same ceiling as the tank cascade table
// 串级主/副环可选被控量：与单回路的 PV 同一张表。
enum { HX_PVX_TI1104 = 0, HX_PVX_FI1105 = 1, HX_PVX_COUNT = 2 };
// 控制方案：与液位一致，0 = 单回路 / 1 = 串级。
enum { HX_MODE_LOOP = 0, HX_MODE_CASC = 1 };
// Saved-state magic, distinct from the tank kernel ('YLHX' vs 'YLV1').
constexpr unsigned int HX_STATE_MAGIC = 0x594C4858u;

struct HxLoop {
    int  pv;         // HX_PV_*
    int  mv;         // HX_MV_*
    bool enabled;
    PID  pid;        // shared controller, Ki = 1 / Ti
};

// 串级回路：阀门 + 主环 + 副环（主环输出换算成副环给定，副环输出驱动阀门）。
// 字段与语义与液位内核的 CascCfg 一一对应，前端串级卡因此可以完全复用。
struct HxCasc {
    int  mv;         // HX_MV_*: valve driven by the inner ring
    int  outer;      // HX_PVX_*: master PV
    int  inner;      // HX_PVX_*: slave PV
    PID  opid, ipid;
    bool enabled;
};

struct HxSystem {
    // --- temperatures ---
    double T;                  // TI1104 shell outlet (true value)
    double T_measured;         // TI1104 after measurement lag
    double setpoint;           // TI1104 setpoint (C)
    double T_inlet;            // TI1103 steam inlet (C)
    double T_chamber;          // furnace equivalent
    double T_target_steady;    // steady target driven by fuel
    double T_wall;
    double T_wall_internal;
    double T_inlet_delayed;
    double T_water_out;
    double T_prev;
    double T_delay_s1;         // TI1104 measurement lag state

    // --- flows ---
    double fuel_flow;          // kg/s
    double steam_flow;         // kg/s (FI1105)
    double steam_flow_setpoint;
    double mw;                 // feedwater flow used by the exchanger
    double mw_effective;
    double flow_setpoint;      // FI1105 setpoint (kg/s)

    // --- valve positions (%) ---
    double fuel_valve_open, fuel_valve_open_eff;
    double water_valve_open, water_valve_open_eff;
    double fv1105_open, fv1105_open_eff, fv1105_open_min;
    double hv1102_open, hv1102_open_eff; // HV1102 过热蒸汽A泄压（压力预留）
    double relieve_flow;                 // 泄压分流 kg/s（诊断）
    double vhand[HX_MV_COUNT]; // manual position of a valve not owned by a loop

    // --- process outputs ---
    double steam_pressure;     // kPa
    double k_hx;               // W/C overall coefficient
    double Q_in, Q_out, Q_loss, Q_hx, Q_metal, Q_spray;
    double steam_quality;
    double FV1102_level;

    // --- flags ---
    bool fuel_temperature_locked;
    bool paused;
    bool running;

    // --- controller table ---
    HxLoop loop[HX_MAX_LOOPS];
    int    nLoop;
    HxCasc casc[HX_MAX_CASC];
    int    nCasc;
    int    mode;               // HX_MODE_LOOP / HX_MODE_CASC
    // 另一方案（单回路 / 串级）的独立表。切换时交换，互不残留也互不丢配置，
    // 与液位内核的 loop_other / loop_other_mode 同构。
    HxLoop loop_other[HX_MAX_LOOPS];
    int    nLoop_other;
    HxCasc casc_other[HX_MAX_CASC];
    int    nCasc_other;
    int    other_mode;         // -1 = 另一方案为空

    // --- bookkeeping ---
    double sim_time;
    double y_axis_max;
};

// ---------------------------------------------------------------------------
// Model surface
// ---------------------------------------------------------------------------
// Fuel flow -> steady TI1103:  T = T_sat + F * 121.43 (capped at 600 C)
double HxSteadyTemperature(double fuel_flow);
// Target TI1103 -> required fuel flow:  F = (T - T_sat) / 121.43
double HxFuelRequired(double target);
// Fuel valve opening (%) -> fuel flow (kg/s), linear characteristic
double HxValveToFuel(double valve_open);

constexpr double HX_DEFAULT_INIT_TEMP_C = 400.0; // 默认初始温度/目标
void HxInit(HxSystem* sys);
void HxSetInitTemp(HxSystem* sys, double t_c); // 教师可调初始温度
void HxSetInletTemp(HxSystem* sys, double t_c); // 学生可调 TI1103 入口蒸汽温度
// 0 = SCENARIO_COOL_480 (hot start, FV1102 cools TI1104)
// 1 = SCENARIO_HEAT_100 (cold start, fuel raises TI1103 and TI1104 follows)
enum { HX_SCENARIO_COOL_480 = 0, HX_SCENARIO_HEAT_100 = 1 };
void HxInitScenario(HxSystem* sys, int scenario);
void HxStep(HxSystem* sys, double dt);

// Loop table helpers (mirror the tank engine's rules and error codes).
enum {
    HX_LOOP_ADD_OK = 0,
    HX_LOOP_ADD_DUPLICATE = -1,
    HX_LOOP_ADD_MV_CONFLICT = -2,
    HX_LOOP_ADD_FULL = -3
};
int HxLoopAdd(HxSystem* sys, int pv, int mv);
bool HxLoopDel(HxSystem* sys, int index);
void HxLoopClear(HxSystem* sys);
// Index of the loop owning a valve, or -1.
int HxLoopByValve(const HxSystem* sys, int mv);
// Index of a loop by PV, or -1.
int HxLoopByPv(const HxSystem* sys, int pv);

// ---- PV 取值 / 给定（主副环共用同一张表）----
double  HxPvValue(const HxSystem* sys, int pv);      // 工程量当前值
double  HxPvSetpoint(const HxSystem* sys, int pv);   // 工程量给定值
void    HxWritePvSetpoint(HxSystem* sys, int pv, double value);
double  HxPvSpan(int pv);                            // 主环输出 0..100 % 换算到副环工程量的量程

// ---- 串级回路 ----
enum {
    HX_CASC_ADD_DUPLICATE   = -1,
    HX_CASC_ADD_MV_CONFLICT = -2,
    HX_CASC_ADD_FULL        = -3,
    HX_CASC_ADD_MODE        = -4
};
// 成功时返回新串级的下标（>= 0），失败返回上面的负数。
int  HxCascAdd(HxSystem* sys, int mv, int outer, int inner);
bool HxCascDel(HxSystem* sys, int index);
void HxCascClear(HxSystem* sys);
// Index of the cascade owning a valve, or -1.
int  HxCascByValve(const HxSystem* sys, int mv);
// 阀门是否已被「单回路或串级」占用。
bool HxValveOccupied(const HxSystem* sys, int mv);
// 切换单回路 / 串级方案。返回 false 表示编号无效。
bool HxSetMode(HxSystem* sys, int mode);

// ---- 模板（F-08 功能对等）：推荐工况 / 高分模板 ----
void HxApplyRecommendedTemplate(HxSystem* sys);
void HxApplyHighScoreTemplate(HxSystem* sys);
