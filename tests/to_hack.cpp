#include<bits/stdc++.h>
// using namespace std;
bool Mst;
double Tst=clock();
#define look_time std::cerr<<clock()-Tst<<" ms\n"
#define re register
#define il inline
#define ll long long
#define ull unsigned long long
// #define int long long
#define fi first
#define se second
#define ep emplace_back
#define ALL(x) (x).begin(),(x).end() 
#define ppc(x) __builtin_popcount(x)
#define ls ((p)<<1)
#define rs (((p)<<1)|1)
#define mid (l+r)>>1
#define lbt(x) ((x)&(-(x)))
#define rep(x,qwq,qaq) for(int x=(qwq);x<=(qaq);++x)
#define per(x,qwq,qaq) for(int x=(qwq);x>=(qaq);--x)
#define pb push_back
#define pii std::pair<int,int>
#define mpr std::make_pair
#define inf 1e18
const int N=1e6+3,M=500;
bool med;
std::mt19937_64 rnd(std::chrono::steady_clock::now().time_since_epoch().count());
int n,mn,cnt;
std::vector<int> st;
inline int rd(){
    int kk=0,f=1;
    char ch=getchar();
    while(ch<'0'||ch>'9'){
        if(ch=='-') f=-1;
        ch=getchar();
    }
    while(ch>='0'&&ch<='9'){
        kk=kk*10+ch-'0';
        ch=getchar();
    }
    return kk*f;
}
void solve(){
    n=rd(),mn=rd();
    st.reserve(n+1);
    rep(i,1,n){
        char op=getchar();
        while(op!='I'&&op!='A'&&op!='S'&&op!='F') op=getchar();
        int x=rd();
        if(op=='I'){
            if(x<mn) continue;
            st.insert(std::lower_bound(st.begin(),st.end(),x),x);
        }else if(op=='A'){
            int tot=st.size();
            rep(i,0,tot-1) st[i]+=x;
        }else if(op=='S'){
            for(auto &v:st) v-=x;
            int pos=std::lower_bound(st.begin(),st.end(),mn)-st.begin();
            cnt+=pos;
            if(pos) st.erase(st.begin(),st.begin()+pos);
        }else{
            int tot=st.size();    
            if(x>tot) std::cout<<-1<<'\n';
            else std::cout<<st[tot-x]<<'\n';
        }
    }
    std::cout<<cnt<<'\n';
}
bool Med;
signed main(){
    // std::ios::sync_with_stdio(false);
    // std::cin.tie(nullptr);
    // freopen("1.in","r",stdin);
    // freopen("1.out","w",stdout);
    // std::cerr<<abs((&Mst-&Med)/1024.0/1024.0)<<" MB\n";
    int T=1;
    // std::cin>>T;
    while(T--) solve();
    // look_time;
    return 0;
}
/*
input:

output:

my:


*/
