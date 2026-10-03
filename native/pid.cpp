#include "pid.h"

bool g_usePidBias = false;   // 默认不叠加前馈偏置，可在控制区自由切换

static double clampd(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

void PidInit(PID* p) {
    if (!p) return;
    p->Kp = 1.0;
    p->Ti = PID_TI_OFF;
    p->Td = 0.0;
    p->action = 1;
    p->out_min = 0.0;
    p->out_max = 100.0;
    p->integral = 0.0;
    p->u_bias = 0.0;
    p->e_prev = 0.0;
    p->d_filt = 0.0;
    p->out = 0.0;
    p->manual = false;
    p->manual_out = 0.0;
    p->snapshot_valid = false;
    p->last_manual = false;
    p->last_action = 1;
    p->last_sp = p->last_pv = p->last_e = 0.0;
    p->last_p_term = p->last_i_term = p->last_d_term = p->last_sum = 0.0;
    p->last_u_bias = p->last_u_raw = p->last_out = 0.0;
}

void PidReset(PID* p, double bias_out) {
    if (!p) return;
    p->u_bias = clampd(bias_out, p->out_min, p->out_max);
    p->integral = 0.0;
    p->e_prev = 0.0;
    p->d_filt = 0.0;
    p->out = p->u_bias;
    p->snapshot_valid = false;
    p->last_u_bias = p->last_u_raw = p->last_out = p->out;
}

// Formula per M1 spec section 3 (literal)
double PidStep(PID* p, double sp, double pv, double dt) {
    if (!p) return 0.0;
    if (dt <= 0.0) dt = 1e-3;

    if (p->manual) {
        // bumpless: bias follows manual output
        p->u_bias = clampd(p->manual_out, p->out_min, p->out_max);
        p->out = p->u_bias;
        const double e = sp - pv;
        p->snapshot_valid = true;
        p->last_manual = true;
        p->last_action = p->action;
        p->last_sp = sp;
        p->last_pv = pv;
        p->last_e = e;
        p->last_p_term = p->Kp * e;
        p->last_i_term = 0.0;
        p->last_d_term = 0.0;
        p->last_sum = 0.0;
        p->last_u_bias = p->u_bias;
        p->last_u_raw = p->out;
        p->last_out = p->out;
        return p->out;
    }

    double e = sp - pv;
    double P = p->Kp * e;
    // 严格口径：Ki = 1/Ti，I 项 = Ki * ∫e dt
    double Iacc = p->integral + e * dt;
    double De = (e - p->e_prev) / dt;
    double tau_f = p->Td;
    if (tau_f < 1.0) tau_f = 1.0;          // tau_f = max(1.0, Td)
    double a = dt / (tau_f + dt);
    double d_filt = (1.0 - a) * p->d_filt + a * De;
    double D = p->Kp * p->Td * d_filt;
    const double Ki = PidKi(p->Ti);
    const double Iterm = Ki * Iacc;

    // Standard field convention: +1 = direct action, -1 = reverse action.
    // With e = SP - PV, reverse action increases MV when PV falls.
    const double bias = g_usePidBias ? p->u_bias : 0.0;
    double u_raw = bias - (double)p->action * (P + Iterm + D);
    double u = clampd(u_raw, p->out_min, p->out_max);

    // Spec M1 §3: 若 u_raw 被限幅 → I -= e*dt（抗积分饱和回退）
    if (u_raw < p->out_min || u_raw > p->out_max) {
        // Do not commit the candidate integral while the output is saturated.
    } else {
        p->integral = Iacc;
    }

    p->d_filt = d_filt;
    p->e_prev = e;
    p->out = u;

    // Snapshot the exact values used by this control step for the UI calculation view.
    p->snapshot_valid = true;
    p->last_manual = false;
    p->last_action = p->action;
    p->last_sp = sp;
    p->last_pv = pv;
    p->last_e = e;
    p->last_p_term = P;
    p->last_i_term = Iterm;
    p->last_d_term = D;
    p->last_sum = P + Iterm + D;
    p->last_u_bias = bias;
    p->last_u_raw = u_raw;
    p->last_out = u;
    return u;
}
