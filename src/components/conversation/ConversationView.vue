<script setup lang="ts">
/**
 * 会话内页：顶栏 + 消息滚动区 + 回到底部按钮 + composer + 权限面板。
 *
 * 滚动契约：用户上翻阅读历史时，新事件不得强制拉底；
 * 只有接近底部时自动跟随，离开底部后显示回到底部按钮。
 *
 * 双态（embedded = 桌面双栏的右侧主区，常驻显示）：
 *   - 顶栏：桌面为 文件夹图标 + 标题 + 溢出占位 + 连接状态；移动保留 ← 返回；
 *   - 无活动会话时主区显示空状态（引导从侧栏选择），不渲染 composer。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useApp } from '../../app/bootstrap.ts';
import { ICON_BACK, ICON_FOLDER, ICON_JUMP_DOWN } from '../../assets/icons';
import { useConversationScroll } from '../../composables/useConversationScroll';
import { cleanTitle } from '../../utils/title';
import ConnectionStatus from '../layout/ConnectionStatus.vue';
import TurnItem from './TurnItem.vue';
import SystemMessage from './SystemMessage.vue';
import Composer from '../composer/Composer.vue';

/** 溢出菜单占位图标（三点）：assets/icons.ts 不在本次写入范围，内联于本组件。 */
const MORE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="0.5" /><circle cx="12" cy="12" r="0.5" /><circle cx="19" cy="12" r="0.5" /></svg>';

const props = defineProps<{ /** 桌面双栏嵌入态：主区常驻，隐藏返回按钮并启用桌面顶栏。 */ embedded?: boolean }>();

const app = useApp();
const { conversation, sessions, ui } = app;

const scroller = ref<HTMLElement | null>(null);
const { jumpVisible, updateJump, scheduleScrollMeasure, scrollBottom, scrollToBottomSmooth, pinToLatest, bindScrollIntent } =
  useConversationScroll(scroller);

const title = computed(() => (sessions.active ? cleanTitle(sessions.active) : '新会话'));

/**
 * 桌面主区空状态：无活动会话时不渲染消息流与 composer。
 *
 * 判据必须用 conversation store 的投影 sessionId（对话通道是否已有活动
 * 会话），不能用 sessions.active —— 新建会话要等下一次 sessions.list 才
 * 进列表，按列表成员资格判断会让「新建后主区永远停在空状态」。
 */
const showEmpty = computed(() => !!props.embedded && !conversation.state.sessionId);

/** 空状态的连接语义文案（与列表副标题同一状态源）。 */
const emptyConnText = computed(() => {
  if (ui.dot === 'on') return '已连接到当前桌面窗口';
  if (ui.dot === 'wait') return '连接中…';
  if (ui.dot === 'err') return '连接异常';
  return '未连接';
});

/**
 * 运行时长刷新用的时钟。
 * 只有存在进行中的回合时才需要跳动（1 秒一次），
 * 没有运行时停掉定时器，避免空转。
 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 需要每秒走动的回合数（本页发起、尚未定格）。
 *
 * 直接读 startedAt / frozenMs，而不是依赖 turns.length 或 running ——
 * 定格只改这两个字段，不改变数组长度，用长度做依赖会漏掉「定格」这一刻，
 * 计时器会多跳到回合结束之后。
 */
const pendingTimers = computed(
  () => conversation.turns.filter((t) => t.startedAt != null && t.frozenMs == null).length
);

const activeTurnId = computed(() => conversation.state.activeTurnId);

function ensureTimer(): void {
  const needTick = pendingTimers.value > 0;
  if (needTick && timer === null) {
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  } else if (!needTick && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

watch(() => [pendingTimers.value, conversation.state.activeTurnId] as const, () => ensureTimer(), {
  immediate: true,
});

// 新内容到达时：贴底跟随中（打开会话后/用户未上翻）强制按在底部，
// 否则按「是否接近底部」决定是否跟随（上翻阅读历史时不打扰）
watch(
  () => conversation.state.items.length,
  () => scrollBottom(false)
);

// 打开/切换会话：默认贴底显示最新内容（对齐官方远程页）。
// bindScrollIntent 把滚轮/触摸/按下识别为「用户主动离开底部」，
// 之后的上翻不会被打回底部（nearBottom 契约继续生效）。
watch(
  () => conversation.state.sessionId,
  async (sid) => {
    if (!sid) return;
    await nextTick();
    bindScrollIntent();
    pinToLatest();
  }
);

function onScroll(): void {
  scheduleScrollMeasure();
}

function goBack(): void {
  ui.setView('sessions');
  void app.loadSessions(false);
}

/**
 * Escape 的优先级链，与原实现一致：
 *   展开的配置面板 → 权限弹层 → 目录弹层 → 返回会话列表。
 * 越靠内的层越先消费 Escape，避免一次按键同时关掉多层。
 * 桌面双栏下主区常驻，「返回列表」无意义，Escape 不再触发视图切换。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (ui.popOpen) {
    ui.closePop();
    return;
  }
  if (app.permission.isOpen) return; // 权限弹层维持不可随意关闭
  if (ui.cwdSheetOpen) return; // 目录弹层有自己的处理（且不在本视图）
  if (props.embedded) return; // 双栏下没有「返回」语义
  goBack();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  updateJump();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});
</script>

<template>
  <div class="app" :hidden="!embedded && ui.view !== 'chat'">
    <div class="conv-topbar">
      <template v-if="embedded">
        <span class="conv-folder" aria-hidden="true" v-html="ICON_FOLDER" />
        <span class="conv-title" :title="title">{{ title }}</span>
        <button
          type="button"
          class="icon-btn"
          disabled
          title="暂未开放"
          aria-label="更多操作（暂未开放）"
        >
          <span v-html="MORE_ICON" />
        </button>
        <ConnectionStatus :state="ui.dot" />
      </template>
      <template v-else>
        <button type="button" class="icon-btn" title="返回会话列表" aria-label="返回会话列表" @click="goBack">
          <span v-html="ICON_BACK" />
        </button>
        <span class="conv-title" :title="title">{{ title }}</span>
        <ConnectionStatus :state="ui.dot" />
      </template>
    </div>

    <div class="conv-main">
      <!-- 桌面双栏空状态：主区常驻但没有活动会话 -->
      <div v-if="showEmpty" class="conv-empty">
        <div class="conv-empty-text">从左侧选择一个会话，或新建会话</div>
        <div class="conv-empty-conn">
          <ConnectionStatus :state="ui.dot" />
          <span>{{ emptyConnText }}</span>
        </div>
      </div>

      <template v-else>
        <div ref="scroller" class="conv-scroller" @scroll="onScroll">
          <!-- id="msgs" 是原样式表的选择器锚点（居中 760px / 行距 20px），不可改名 -->
          <div id="msgs" role="region" :aria-label="'会话 ' + title">
            <!-- 回放中给出明确状态，避免历史空白被误认为「没有内容」 -->
            <div v-if="conversation.state.replaying" class="msg sys" role="status" aria-live="polite">
              <span class="spin" /> 正在重建历史…
            </div>

            <template v-for="item in conversation.state.items" :key="item.id">
              <SystemMessage v-if="item.type === 'system'" :block="item" />
              <TurnItem
                v-else
                :turn="item"
                :now="item.id === activeTurnId ? now : undefined"
              />
            </template>
          </div>
        </div>

        <button
          type="button"
          class="conv-jump"
          :class="{ show: jumpVisible }"
          title="滚动到底部"
          aria-label="滚动到底部"
          @click="scrollToBottomSmooth"
        >
          <span v-html="ICON_JUMP_DOWN" />
        </button>

        <Composer />
      </template>
    </div>
  </div>
</template>
