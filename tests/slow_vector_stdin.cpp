// slow_vector.cpp — 被卡实现 A：有序 vector，插入/前缀删除 O(n)
// 同时作为小数据下的暴力对拍参考（逻辑直白）
#include <bits/stdc++.h>
using namespace std;
typedef long long ll;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int m; ll p;
    if (!(cin >> m >> p)) return 0;
    vector<ll> v; // 升序，存真实工资（本题实现常用写法：不偏移，A/S 直接改 delta 或整体更新）
    ll delta = 0;
    ll fired = 0;
    for (int i = 0; i < m; ++i) {
        char op; ll x;
        cin >> op >> x;
        if (op == 'I') {
            if (x >= p) {
                ll key = x - delta;
                auto it = lower_bound(v.begin(), v.end(), key);
                v.insert(it, key); // O(n)
            }
            // 初始工资 < 下界：离开但不计入离职总数
        } else if (op == 'A') {
            delta += x;
        } else if (op == 'S') {
            delta -= x;
            ll th = p - delta;
            auto it = lower_bound(v.begin(), v.end(), th);
            fired += (ll)(it - v.begin());
            v.erase(v.begin(), it); // O(n)
        } else {
            ll k = x;
            if (k > (ll)v.size()) { cout << -1 << '\n'; continue; } // k 大于员工数
            cout << v[v.size() - k] + delta << '\n'; // 第 k 高 = 升序第 size-k 个（下标 size-k）
        }
    }
    cout << fired << '\n'; // 离职员工总数
    return 0;
}
