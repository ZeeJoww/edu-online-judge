// std.cpp — 标准答案：FHQ-Treap，全局 delta 偏移
// 用法: ./std <in> <out>
#include <bits/stdc++.h>
using namespace std;
typedef long long ll;

struct Node {
    ll val;
    int pri, sz;
    Node *l, *r;
    Node(ll v) : val(v), pri(rand()), sz(1), l(nullptr), r(nullptr) {}
};
static inline int gsz(Node* t) { return t ? t->sz : 0; }
static inline void pull(Node* t) { if (t) t->sz = gsz(t->l) + gsz(t->r) + 1; }

Node* merge(Node* a, Node* b) {
    if (!a) return b;
    if (!b) return a;
    if (a->pri < b->pri) { a->r = merge(a->r, b); pull(a); return a; }
    else { b->l = merge(a, b->l); pull(b); return b; }
}
// split: a 含 val < key, b 含 val >= key
void split(Node* t, ll key, Node*& a, Node*& b) {
    if (!t) { a = b = nullptr; return; }
    if (t->val < key) { split(t->r, key, t->r, b); a = t; pull(a); }
    else { split(t->l, key, a, t->l); b = t; pull(b); }
}
ll kth(Node* t, int k) { // 1-based 第 k 小
    int lsz = gsz(t->l);
    if (k <= lsz) return kth(t->l, k);
    if (k == lsz + 1) return t->val;
    return kth(t->r, k - lsz - 1);
}

int main() {
    srand(1234567);

    int m; ll p;
    if (!(cin >> m >> p)) return 0;
    Node* root = nullptr;
    ll delta = 0;
    ll fired = 0; // 题目只要求输出 F 结果，离职数不输出但正确维护
    for (int i = 0; i < m; ++i) {
        char op; ll x;
        cin >> op >> x;
        if (op == 'I') {
            if (x >= p) {
                ll v = x - delta;
                Node *L, *R;
                split(root, v, L, R);
                root = merge(merge(L, new Node(v)), R);
            }
            // 初始工资 < 下界：立刻离开，但不算做离开公司的员工（不计入 fired）
        } else if (op == 'A') {
            delta += x;
        } else if (op == 'S') {
            delta -= x;
            Node *L, *R;
            split(root, p - delta, L, R); // 删除基准 v < p-delta 的（真实工资 < p）
            fired += gsz(L);
            root = R;
        } else { // F
            ll k = x;
            int sz = gsz(root);
            if (k > (ll)sz) { cout << -1 << '\n'; continue; } // k 大于员工数
            ll ans = kth(root, sz - (int)k + 1) + delta; // 第 k 高 = 第 size-k+1 小
            cout << ans << '\n';
        }
    }
    cout << fired << '\n'; // 最后一行：离职员工总数
    return 0;
}
