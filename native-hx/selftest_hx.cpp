// selftest_hx.cpp -- headless self test for the heat exchanger kernel.
//
// Covers the physics port (scenario A/B parity with the desktop build), the
// shared PID convention (Ki = 1/Ti, Ti = inf disables the integral), the loop
// table rules and the steam path algebra.

#include "hx_model.h"

#include <cmath>
#include <cstdio>
#include <cstring>

static int failures = 0;
static int checks = 0;

static void expect_near(const char* name, double got, double want, double tol) {
    checks++;
    if (std::fabs(got - want) > tol) {
        std::printf("FAIL %-28s got=%.6f want=%.6f\n", name, got, want);
        failures++;
    } else {
        std::printf("OK   %-28s %.6f\n", name, got);
    }
}

static void expect_true(const char* name, bool cond) {
    checks++;
    if (!cond) {
        std::printf("FAIL %s\n", name);
        failures++;
    } else {
        std::printf("OK   %s\n", name);
    }
}

static void step(HxSystem* sys, int n, double dt = 1.0) {
    for (int i = 0; i < n; ++i) HxStep(sys, dt);
}

int main() {
    HxSystem sys;

    std::printf("=== algebra ===\n");
    expect_near("FuelRequired(480)", HxFuelRequired(480.0), (480.0 - 250.0) / 121.43, 1e-9);
    expect_near("SteadyTemperature(F)", HxSteadyTemperature(HxFuelRequired(480.0)), 480.0, 1e-6);
    expect_near("Steady cap at 600", HxSteadyTemperature(6.0), 600.0, 1e-9);
    expect_near("ValveToFuel(50)", HxValveToFuel(50.0), 3.0, 1e-9);

    std::printf("\n=== scenario A: hot start, cooling valve ===\n");
    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    // 默认初温/SP = HX_DEFAULT_INIT_TEMP_C（400），TI1103 与之一致
    expect_near("A.T_inlet", sys.T_inlet, HX_DEFAULT_INIT_TEMP_C, 0.01);
    expect_near("A.T", sys.T, HX_DEFAULT_INIT_TEMP_C, 0.01);
    expect_near("A.SP", sys.setpoint, HX_DEFAULT_INIT_TEMP_C, 0.01);
    expect_near("A.fuel", sys.fuel_flow, HxFuelRequired(HX_DEFAULT_INIT_TEMP_C), 1e-6);
    expect_true("A.fuel locked", sys.fuel_temperature_locked);
    expect_near("A.FV1102 closed", sys.water_valve_open, 0.0, 0.01);
    expect_true("A.steam flow at design", sys.steam_flow > 15.0);
    expect_true("A.paused", sys.paused);
    expect_near("A.sim_time", sys.sim_time, 0.0, 1e-12);

    // Paused kernels must not advance.
    step(&sys, 5);
    expect_near("A.paused holds sim_time", sys.sim_time, 0.0, 1e-12);

    // 强制热态起点，专测冷却阀物理（与默认初温解耦）
    sys.T = 480.0;
    sys.T_measured = 480.0;
    sys.T_prev = 480.0;
    sys.T_delay_s1 = 480.0;
    sys.T_inlet = 480.0;
    sys.T_inlet_delayed = 480.0;
    sys.T_target_steady = 480.0;
    sys.T_wall = 500.0;
    sys.T_wall_internal = 510.0;
    sys.setpoint = 450.0;
    sys.paused = false;
    sys.running = true;
    // Temperature loop on FV1102, cooling the outlet from 480 to 450.
    expect_true("A.loop add temp", HxLoopAdd(&sys, HX_PV_TI1104, HX_MV_FV1102) == HX_LOOP_ADD_OK);
    HxLoop* tloop = &sys.loop[0];
    tloop->pid.Kp = 10.0;
    tloop->pid.Ti = 10.0;
    tloop->pid.Td = 0.0;
    tloop->pid.action = 1;
    tloop->pid.manual = false;
    PidReset(&tloop->pid, 0.0);
    const double t_before = sys.T;
    step(&sys, 120);
    std::printf("     after 120 s: TI1104=%.2f valve=%.2f open=%.2f TI1103=%.2f\n",
                sys.T, sys.water_valve_open_eff, sys.water_valve_open, sys.T_inlet);
    expect_true("A.FV1102 opens to cool", sys.water_valve_open_eff > 1.0);
    expect_true("A.TI1104 falls", sys.T < t_before - 0.5);
    expect_near("A.TI1103 held (locked)", sys.T_inlet, 480.0, 2.0);

    std::printf("\n=== student inlet temp (TI1103) ===\n");
    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    sys.paused = false;
    sys.running = true;
    HxSetInletTemp(&sys, 520.0);
    expect_near("inlet set", sys.T_inlet, 520.0, 0.01);
    expect_near("inlet delayed", sys.T_inlet_delayed, 520.0, 0.01);
    expect_near("inlet target", sys.T_target_steady, 520.0, 0.01);
    expect_true("inlet locked", sys.fuel_temperature_locked);
    step(&sys, 30);
    expect_near("inlet held after step", sys.T_inlet, 520.0, 1.0);
    HxSetInletTemp(&sys, 200.0); // clamp to 250
    expect_near("inlet clamped low", sys.T_inlet, 250.0, 0.01);
    HxSetInletTemp(&sys, 700.0); // clamp to 650
    expect_near("inlet clamped high", sys.T_inlet, 650.0, 0.01);

    std::printf("\n=== inlet/outlet coupling before start ===\n");
    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    expect_true("cold not running", !sys.running);
    HxSetInletTemp(&sys, 520.0);
    expect_near("prestart inlet", sys.T_inlet, 520.0, 0.01);
    expect_near("prestart outlet tracks", sys.T, 520.0, 0.01);
    expect_near("prestart measured tracks", sys.T_measured, 520.0, 0.01);
    HxSetInletTemp(&sys, 360.0);
    expect_near("prestart inlet down", sys.T_inlet, 360.0, 0.01);
    expect_true("prestart outlet not above inlet", sys.T <= sys.T_inlet + 1e-6);
    expect_near("prestart outlet follow down", sys.T, 360.0, 0.01);
    expect_true("water out not above inlet", sys.T_water_out <= sys.T_inlet + 1e-6);

    std::printf("\n=== scenario B: cold start, fuel drives TI1103 ===\n");
    HxInitScenario(&sys, HX_SCENARIO_HEAT_100);
    expect_near("B.T_inlet", sys.T_inlet, HX_T_SAT, 0.01);
    expect_near("B.T", sys.T, 100.0, 0.01);
    expect_near("B.target", sys.T_target_steady, 480.0, 0.01);
    expect_true("B.fuel unlocked", !sys.fuel_temperature_locked);
    const double ti1103_0 = sys.T_inlet;
    const double ti1104_0 = sys.T;
    sys.paused = false;
    sys.running = true;
    step(&sys, 80);
    std::printf("     after 80 s: TI1103=%.2f (was %.2f) TI1104=%.2f (was %.2f)\n",
                sys.T_inlet, ti1103_0, sys.T, ti1104_0);
    expect_true("B.TI1103 rises", sys.T_inlet > ti1103_0 + 5.0);
    expect_true("B.TI1104 follows", sys.T > ti1104_0 + 5.0);
    expect_near("B.target holds", sys.T_target_steady, 480.0, 0.1);

    std::printf("\n=== PID convention: Ki = 1 / Ti ===\n");
    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    sys.paused = false;
    sys.running = true;
    HxLoopClear(&sys);
    HxLoopAdd(&sys, HX_PV_TI1104, HX_MV_FV1102);
    {
        HxLoop* L = &sys.loop[0];
        L->pid.Kp = 0.0;
        L->pid.Ti = 20.0;
        L->pid.Td = 0.0;
        L->pid.action = 1;
        L->pid.manual = false;
        PidReset(&L->pid, 0.0);
    }
    sys.setpoint = 470.0;   // e = SP - PV = -10 K, constant while T holds
    // Freeze the loop measurement by feeding a constant PV state.
    for (int i = 0; i < 5; ++i) {
        sys.T_measured = 480.0;
        sys.T = 480.0;
        HxStep(&sys, 1.0);
    }
    const double expected_i = -(10.0 / 20.0) * 5.0;   // -(e/Ti)*n = -2.5
    expect_near("PidStep iTerm = (1/Ti)*integral", sys.loop[0].pid.last_i_term, expected_i, 1e-6);

    // Ti = inf must switch the integral off completely, not blow up.
    {
        HxLoop* L = &sys.loop[0];
        L->pid.Kp = 0.0;
        L->pid.Ti = PID_TI_OFF;
        PidReset(&L->pid, 0.0);
    }
    for (int i = 0; i < 5; ++i) {
        sys.T_measured = 480.0;
        sys.T = 480.0;
        HxStep(&sys, 1.0);
    }
    expect_near("Ti = inf -> iTerm 0", sys.loop[0].pid.last_i_term, 0.0, 1e-12);

    std::printf("\n=== loop table rules ===\n");
    HxLoopClear(&sys);
    expect_true("add temp/FV1102", HxLoopAdd(&sys, HX_PV_TI1104, HX_MV_FV1102) == HX_LOOP_ADD_OK);
    expect_true("duplicate rejected", HxLoopAdd(&sys, HX_PV_TI1104, HX_MV_FV1102) == HX_LOOP_ADD_DUPLICATE);
    expect_true("same valve conflict rejected", HxLoopAdd(&sys, HX_PV_FI1105, HX_MV_FV1102) == HX_LOOP_ADD_MV_CONFLICT);
    expect_true("second loop accepted", HxLoopAdd(&sys, HX_PV_FI1105, HX_MV_FV1105) == HX_LOOP_ADD_OK);
    expect_true("loop count 2", sys.nLoop == 2);
    expect_true("valve owner lookup", HxLoopByValve(&sys, HX_MV_FV1105) == 1);
    expect_true("pv owner lookup", HxLoopByPv(&sys, HX_PV_TI1104) == 0);
    expect_true("delete loop 0", HxLoopDel(&sys, 0));
    expect_true("owner reindexed", HxLoopByValve(&sys, HX_MV_FV1105) == 0);
    HxLoopClear(&sys);
    expect_true("clear empties table", sys.nLoop == 0);

    std::printf("\n=== recommended template is single loop ===\n");
    sys.mode = HX_MODE_CASC;
    HxApplyRecommendedTemplate(&sys);
    expect_true("recommended switches to loop mode", sys.mode == HX_MODE_LOOP);
    expect_true("recommended has no cascade", sys.nCasc == 0);
    expect_true("recommended has one loop", sys.nLoop == 1);
    if (sys.nLoop == 1) {
        expect_true("recommended PV is TI1104", sys.loop[0].pv == HX_PV_TI1104);
        expect_true("recommended MV is FV1102", sys.loop[0].mv == HX_MV_FV1102);
        expect_true("recommended loop is automatic", !sys.loop[0].pid.manual);
        expect_near("recommended SP", sys.setpoint, HX_DEFAULT_INIT_TEMP_C, 1e-9);
    }

    std::printf("\n=== steam path ===\n");
    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    sys.paused = false;
    sys.running = true;
    sys.vhand[HX_MV_FV1105] = 100.0;
    step(&sys, 60);
    std::printf("     FV1105=100%% -> FI1105=%.3f kg/s (sp %.3f)\n", sys.steam_flow, sys.steam_flow_setpoint);
    expect_true("full opening gives high flow", sys.steam_flow > 60.0);
    expect_true("flow respects span", sys.steam_flow <= HX_MAX_FV1105_FLOW + 1e-9);

    HxInitScenario(&sys, HX_SCENARIO_COOL_480);
    sys.paused = false;
    sys.running = true;
    sys.vhand[HX_MV_FV1105] = 0.0;
    step(&sys, 60);
    expect_near("closed valve stops steam", sys.steam_flow, 0.0, 1e-6);

    std::printf("\n=== state magic ===\n");
    expect_true("hx magic differs from tank", HX_STATE_MAGIC != 0x594C5631u);

    std::printf("\n%s: %d checks, %d failures\n",
                failures ? "TEST FAILED" : "TEST PASSED", checks, failures);
    return failures ? 1 : 0;
}
