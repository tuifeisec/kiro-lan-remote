import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 样式按关注点拆分，加载顺序即层叠顺序：令牌 → 重置 → 布局 → 内容 → 动效 → 组件
import './assets/styles/tokens.css';
import './assets/styles/base.css';
import './assets/styles/layout.css';
import './assets/styles/conversation.css';
import './assets/styles/transitions.css';
import './assets/styles/composer.css';
import './assets/styles/sheets.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
