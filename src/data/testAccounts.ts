/**
 * MVP v1.0 测试账号数据
 * 开发环境使用，生产环境由 CloudBase Auth 替代
 */

export interface TestAccount {
  id: string;
  username: string;
  password: string;
  nickname: string;
  level: number;
  /** 系统账户不可登录（仅内部使用） */
  systemOnly?: boolean;
  /** 账户角色 */
  role?: 'player' | 'developer' | 'admin' | 'platform';
}

const ACCOUNTS: TestAccount[] = [
  { id: 'test-001', username: 'player1', password: 'Abc123', nickname: '冒险者小明', level: 5, role: 'player' },
  { id: 'test-002', username: 'player2', password: 'Abc123', nickname: '探险家小红', level: 3, role: 'player' },
  { id: 'test-003', username: 'dev1',    password: 'Dev123', nickname: '开发者老张', level: 10, role: 'developer' },
  { id: 'test-004', username: 'admin',   password: 'Admin1', nickname: '管理员',     level: 99, role: 'admin' },
];

/** 平台系统账户（不可登录，仅用于金库收款/凭证回收） */
export const PLATFORM_ACCOUNTS = {
  treasury: {
    id: 'system-platform',
    name: '平台金库',
    role: 'platform' as const,
    description: '平台佣金、提案押金、凭证回收的统一收款账户',
  },
  pool: {
    id: 'platform_pool',
    name: '平台总账户',
    role: 'platform' as const,
    description: 'A币凭证流转池（P2P支付中转）',
  },
};

export function validateUser(username: string, password: string): TestAccount | null {
  return ACCOUNTS.find(a => a.username === username && a.password === password) || null;
}

export function getTestAccountCredentials(): Array<TestAccount & { email: string }> {
  return ACCOUNTS.map(a => ({ ...a, email: `${a.username}@allinone.test` }));
}

/** 开发环境本地注册（存入 AuthSkill localStorage fallback） */
export function saveRegisteredUser(user: { username: string; email: string; password: string }): void {
  const users = JSON.parse(localStorage.getItem('allinone_users') || '[]');
  // 防止重复
  if (users.find((u: any) => u.email === user.email)) return;
  users.push({
    uid: 'local_' + Date.now(),
    nickname: user.username,
    email: user.email,
    password: user.password,
  });
  localStorage.setItem('allinone_users', JSON.stringify(users));
}
