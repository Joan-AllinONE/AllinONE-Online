/* ==========================================================
 * wordlist.js — 每日单词默认词库
 *
 * 格式：{ w: 单词, p: 音标, c: 中文, e: 例句 }
 * 每天取 3 个，60 个词 = 20 天一轮，走完自动回到开头。
 *
 * 想换成自己的词库，三种方式任选：
 *   1) 直接改本文件的 PET_WORDLIST 数组
 *   2) 把另一个 js 文件放在本文件之后覆盖 window.PET_WORDLIST
 *   3) 运行时在「🔤 今日单词」面板里粘贴自定义词库（存 localStorage，优先级最高）
 *
 * 自定义文本格式（每行一个，| 分隔，音标和例句可省略）：
 *   apple|/ˈæpl/|苹果|I eat an apple.
 *   hello||你好
 * ========================================================== */
window.PET_WORDLIST = [
  { w: 'apple',      p: '/ˈæpl/',        c: '苹果',     e: 'I eat an apple every morning.' },
  { w: 'friend',     p: '/frend/',       c: '朋友',     e: 'She is my best friend.' },
  { w: 'happy',      p: '/ˈhæpi/',       c: '快乐的',   e: 'You look happy today.' },
  { w: 'water',      p: '/ˈwɔːtə(r)/',   c: '水',       e: 'Please drink more water.' },
  { w: 'window',     p: '/ˈwɪndəʊ/',     c: '窗户',     e: 'Open the window, please.' },
  { w: 'morning',    p: '/ˈmɔːnɪŋ/',     c: '早晨',     e: 'Good morning!' },
  { w: 'coffee',     p: '/ˈkɒfi/',       c: '咖啡',     e: 'A cup of coffee, please.' },
  { w: 'quiet',      p: '/ˈkwaɪət/',     c: '安静的',   e: 'Keep quiet in the library.' },
  { w: 'travel',     p: '/ˈtrævl/',      c: '旅行',     e: 'I want to travel the world.' },
  { w: 'weather',    p: '/ˈweðə(r)/',    c: '天气',     e: 'The weather is nice today.' },
  { w: 'kitchen',    p: '/ˈkɪtʃɪn/',     c: '厨房',     e: 'Mom is in the kitchen.' },
  { w: 'memory',     p: '/ˈmeməri/',     c: '记忆',     e: 'That song brings back memories.' },
  { w: 'simple',     p: '/ˈsɪmpl/',      c: '简单的',   e: 'Keep it simple.' },
  { w: 'dinner',     p: '/ˈdɪnə(r)/',    c: '晚餐',     e: 'Dinner is ready.' },
  { w: 'forest',     p: '/ˈfɒrɪst/',     c: '森林',     e: 'We walked in the forest.' },
  { w: 'brave',      p: '/breɪv/',       c: '勇敢的',   e: 'Be brave, you can do it.' },
  { w: 'pocket',     p: '/ˈpɒkɪt/',      c: '口袋',     e: 'The key is in my pocket.' },
  { w: 'mountain',   p: '/ˈmaʊntən/',    c: '山',       e: 'The mountain is covered with snow.' },
  { w: 'gentle',     p: '/ˈdʒentl/',     c: '温柔的',   e: 'He has a gentle voice.' },
  { w: 'weekend',    p: '/ˌwiːkˈend/',   c: '周末',     e: 'Have a nice weekend!' },
  { w: 'library',    p: '/ˈlaɪbrəri/',   c: '图书馆',   e: 'I study in the library.' },
  { w: 'engine',     p: '/ˈendʒɪn/',     c: '发动机',   e: 'The engine is running.' },
  { w: 'purple',     p: '/ˈpɜːpl/',      c: '紫色的',   e: 'She wears a purple dress.' },
  { w: 'island',     p: '/ˈaɪlənd/',     c: '岛屿',     e: 'They live on a small island.' },
  { w: 'market',     p: '/ˈmɑːkɪt/',     c: '市场',     e: 'I buy fruit at the market.' },
  { w: 'notebook',   p: '/ˈnəʊtbʊk/',    c: '笔记本',   e: 'Write it in your notebook.' },
  { w: 'silver',     p: '/ˈsɪlvə(r)/',   c: '银；银色', e: 'a silver ring' },
  { w: 'ticket',     p: '/ˈtɪkɪt/',      c: '票',       e: 'I bought two tickets.' },
  { w: 'garden',     p: '/ˈɡɑːdn/',      c: '花园',     e: 'The garden is full of flowers.' },
  { w: 'clever',     p: '/ˈklevə(r)/',   c: '聪明的',   e: 'What a clever idea!' },
  { w: 'bottle',     p: '/ˈbɒtl/',       c: '瓶子',     e: 'a bottle of water' },
  { w: 'shadow',     p: '/ˈʃædəʊ/',      c: '影子',     e: 'The dog chased its shadow.' },
  { w: 'hungry',     p: '/ˈhʌŋɡri/',     c: '饥饿的',   e: "I'm so hungry." },
  { w: 'palace',     p: '/ˈpæləs/',      c: '宫殿',     e: 'The palace is very old.' },
  { w: 'river',      p: '/ˈrɪvə(r)/',    c: '河流',     e: 'We swam in the river.' },
  { w: 'bright',     p: '/braɪt/',       c: '明亮的',   e: 'a bright room' },
  { w: 'camera',     p: '/ˈkæmərə/',     c: '相机',     e: 'Smile for the camera!' },
  { w: 'lucky',      p: '/ˈlʌki/',       c: '幸运的',   e: 'You are so lucky.' },
  { w: 'bridge',     p: '/brɪdʒ/',       c: '桥',       e: 'Cross the bridge.' },
  { w: 'honey',      p: '/ˈhʌni/',       c: '蜂蜜',     e: 'honey in my tea' },
  { w: 'village',    p: '/ˈvɪlɪdʒ/',     c: '村庄',     e: 'a quiet village' },
  { w: 'machine',    p: '/məˈʃiːn/',     c: '机器',     e: 'The machine stopped working.' },
  { w: 'autumn',     p: '/ˈɔːtəm/',      c: '秋天',     e: 'Leaves fall in autumn.' },
  { w: 'blanket',    p: '/ˈblæŋkɪt/',    c: '毯子',     e: 'a warm blanket' },
  { w: 'dolphin',    p: '/ˈdɒlfɪn/',     c: '海豚',     e: 'Dolphins are smart.' },
  { w: 'future',     p: '/ˈfjuːtʃə(r)/', c: '未来',     e: 'in the near future' },
  { w: 'glasses',    p: '/ˈɡlɑːsɪz/',    c: '眼镜',     e: 'Where are my glasses?' },
  { w: 'journey',    p: '/ˈdʒɜːni/',     c: '旅程',     e: 'Have a safe journey.' },
  { w: 'lantern',    p: '/ˈlæntən/',     c: '灯笼',     e: 'a paper lantern' },
  { w: 'meadow',     p: '/ˈmedəʊ/',      c: '草地',     e: 'sheep in the meadow' },
  { w: 'nephew',     p: '/ˈnefjuː/',     c: '侄子',     e: 'My nephew is five.' },
  { w: 'oxygen',     p: '/ˈɒksɪdʒən/',   c: '氧气',     e: 'We need oxygen to live.' },
  { w: 'pebble',     p: '/ˈpebl/',       c: '小石子',   e: 'a pebble on the beach' },
  { w: 'recipe',     p: '/ˈresəpi/',     c: '食谱',     e: 'a recipe for cake' },
  { w: 'sunset',     p: '/ˈsʌnset/',     c: '日落',     e: 'Watch the sunset with me.' },
  { w: 'thunder',    p: '/ˈθʌndə(r)/',   c: '雷',       e: 'thunder and lightning' },
  { w: 'umbrella',   p: '/ʌmˈbrelə/',    c: '雨伞',     e: "Take an umbrella. It's raining." },
  { w: 'violet',     p: '/ˈvaɪələt/',    c: '紫罗兰',   e: 'violets in spring' },
  { w: 'whisper',    p: '/ˈwɪspə(r)/',   c: '低语',     e: 'She whispered a secret.' },
  { w: 'yesterday',  p: '/ˈjestədeɪ/',   c: '昨天',     e: 'I called you yesterday.' }
];
