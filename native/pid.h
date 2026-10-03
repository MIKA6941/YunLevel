#pragma once
#include <cmath>
#include <limits>

// 严格口径：Ki = 1/Ti；Ti = 0 不是“关闭积分”，而是数学上使 Ki 趋于无穷。
// 需要关闭积分时使用 Ti = ∞，此时 Ki = 1/∞ = 0。
constexpr double PID_TI_OFF = std::numeric_limits<double>::infinity();
inline bool PidTiOff(double ti) { return std::isinf(ti) && ti > 0.0; }
inline double PidKi(double ti) { return 1.0 / ti; }   // 不做 Ti=0 特判

extern bool g_usePidBias;   // true = u = u_ff + u_fb；false = u = u_fb

struct PID {
    double Kp, Ti, Td;          // Ti=∞ 表示关闭积分；Td=0 表示关闭微分
    int    action;              // +1 正作用, -1 反作用
    double out_min, out_max;    // 输出限幅 (%)
    double integral;            // 积分累加量 I
    double u_bias;              // 偏置 (M1)
    double e_prev, d_filt;      // 上一步误差 / 微分滤波值
    double out;                 // 最近一次输出 (%)
    bool   manual;              // true = 手动
    double manual_out;          // 手动输出 (%)

    // 最近一次实际参与运算的数据快照：界面逐项复算时直接引用，避免读取“下一拍状态”造成偏差。
    bool   snapshot_valid;
    bool   last_manual;
    int    last_action;
    double last_sp, last_pv, last_e;
    double last_p_term, last_i_term, last_d_term, last_sum;
    double last_u_bias, last_u_raw, last_out;
};
void   PidInit(PID* p);
void   PidReset(PID* p, double bias_out);          // 无扰切换：以当前输出为偏置
double PidStep(PID* p, double sp, double pv, double dt);  // 返回操纵变量 %
