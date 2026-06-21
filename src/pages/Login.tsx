import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useContext } from 'react';
import { AuthContext } from '@/contexts/authContext';
import { toast } from 'sonner';
import { validateUser, getTestAccountCredentials } from '@/data/testAccounts';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showTestAccounts, setShowTestAccounts] = useState(false);
  const { login, setIsAuthenticated, setCurrentUser } = useContext(AuthContext);
  const navigate = useNavigate();

  const testCredentials = getTestAccountCredentials();

  // ==================== 保存测试账号用户到 React 状态 ====================
  const persistTestUser = (account: any) => {
    const authUser = {
      id: account.id,
      uid: account.id,
      username: account.username,
      email: `${account.username}@allinone.test`,
      nickname: account.nickname,
      role: account.role || 'player',
      gameCoins: 0,
    };

    // 写入 allinone_user（AuthProvider / AuthSkill 读取此 key 做会话恢复）
    localStorage.setItem('allinone_user', JSON.stringify(authUser));

    // 通知事件
    window.dispatchEvent(new CustomEvent('localStorageChange'));
    window.dispatchEvent(new Event('allinoneAuthChange'));

    // 更新 React 状态
    setCurrentUser(authUser);
    setIsAuthenticated(true);
  };

  // ==================== CloudBase / AuthSkill 登录 ====================
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('请输入邮箱和密码');
      return;
    }
    setIsLoading(true);

    try {
      const result = await login(email, password);
      if (result.success) {
        toast.success('登录成功！');
        navigate('/');
      } else {
        // CloudBase Auth 失败，尝试本地账号（从 email 提取 username）
        const usernameFromEmail = email.includes('@') ? email.split('@')[0] : email;
        const account = validateUser(usernameFromEmail, password);
        if (account) {
          console.log(`[Login] 本地测试账号匹配: id=${account.id}, username=${account.username}`);
          persistTestUser(account);
          toast.success(`欢迎回来，${account.nickname}！`);
          navigate('/');
        } else {
          toast.error(result.error || '邮箱或密码错误');
        }
      }
    } catch (err: any) {
      toast.error(err?.message || '登录失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  // ==================== 测试账号快捷登录 ====================
  const handleTestAccountLogin = (testUsername: string, testPassword: string) => {
    const account = validateUser(testUsername, testPassword);
    if (!account) { toast.error('测试账号不可用'); return; }
    console.log(`[Login] 测试账号快捷登录: id=${account.id}, username=${account.username}`);
    persistTestUser(account);
    toast.success(`欢迎回来，${account.nickname}！`);
    setShowTestAccounts(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-xl">A</span>
            </div>
            <span className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">AllinONE</span>
          </div>
          <h1 className="text-2xl font-bold">欢迎回来</h1>
          <p className="text-slate-600 dark:text-slate-300">登录您的账户，继续游戏之旅</p>
        </div>
        
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-6 md:p-8">
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
                邮箱
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <i className="fa-solid fa-envelope text-slate-400"></i>
                </div>
                <input
                  type="email"
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="your@email.com"
                  required
                />
              </div>
            </div>
            
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
                密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <i className="fa-solid fa-lock text-slate-400"></i>
                </div>
                <input
                  type="password"
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="请输入密码"
                  required
                />
              </div>
            </div>
            
            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-80 disabled:cursor-not-allowed transition-all"
              >
                {isLoading ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin mr-2"></i>
                    登录中...
                  </>
                ) : '登录'}
              </button>
            </div>
          </form>
          
          <div className="mt-6 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              还没有账户？{' '}
              <Link to="/register" className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300">
                立即注册
              </Link>
            </p>
          </div>
          
          {/* 测试账号入口（仅开发环境） */}
          <div className="mt-8">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-300 dark:border-slate-600"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                  测试账号
                </span>
              </div>
            </div>
            
            <div className="mt-6">
              <button
                onClick={() => setShowTestAccounts(!showTestAccounts)}
                className="w-full flex justify-center items-center gap-2 py-3 px-4 border border-slate-300 dark:border-slate-600 rounded-lg shadow-sm text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all"
              >
                <i className="fa-solid fa-vial text-green-600"></i>
                {showTestAccounts ? '隐藏测试账号' : '显示测试账号'}
                <i className={`fa-solid fa-chevron-${showTestAccounts ? 'up' : 'down'} text-xs`}></i>
              </button>
              
              {showTestAccounts && (
                <div className="mt-4 space-y-2 max-h-64 overflow-y-auto">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-2 px-2">
                    点击任意账号自动填入登录信息
                  </div>
                  {testCredentials.map((account, index) => (
                    <div
                      key={index}
                      onClick={() => handleTestAccountLogin(account.username, account.password)}
                      className="p-3 border border-slate-200 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer transition-all"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-white">
                            {account.nickname}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {account.username}@allinone.test
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-full">
                            Lv.{account.level}
                          </span>
                          <i className="fa-solid fa-arrow-right text-xs text-slate-400"></i>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                        密码: {account.password}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
