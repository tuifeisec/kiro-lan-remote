<script setup lang="ts">
/**
 * 工作过程面板：过程叙述与工具行按事件顺序交错。
 *
 * 契约：
 *   - 运行中自动展开、完成后默认收起；
 *   - 折叠按钮只控制**自己所在回合**的面板（不依赖全局当前回合）；
 *   - 迟到事件不得重新展开已结束的面板（由 reducer 的 settled 保证）。
 */
import { computed, ref, watch } from 'vue';
import type { ThoughtBlock, Turn } from '../../domain/messageModel.ts';
import { fmtDuration } from '../../utils/time';
import { ICON_CHEV_DOWN } from '../../assets/icons';
import MarkdownBlock from '../markdown/MarkdownBlock.vue';
import ToolCallRow from './ToolCallRow.vue';

const props = defineProps<{ turn: Turn; now?: number }>();

const PROCESS_PAGE_SIZE = 120;
const visibleProcessCount = ref(PROCESS_PAGE_SIZE);

const visibleProcess = computed(() => {
  const process = props.turn.process;
  if (process.length <= visibleProcessCount.value) return process;
  return process.slice(Math.max(0, process.length - visibleProcessCount.value));
});

const hasEarlierProcess = computed(
  () => props.turn.process.length > visibleProcessCount.value
);

function showEarlierProcess(): void {
  visibleProcessCount.value = Math.min(
    props.turn.process.length,
    visibleProcessCount.value + PROCESS_PAGE_SIZE
  );
}

/** 折叠按钮与受控面板的关联 id：同一回合内必须唯一且稳定。 */
const panelId = computed(() => 'wr-panel-' + props.turn.id.replace(/[^a-zA-Z0-9_-]/g, '_'));

const expanded = ref(props.turn.expanded);

// 回合状态变化时同步展开态：结束后收起（除非用户手动展开过）
watch(
  () => props.turn.expanded,
  (v) => {
    expanded.value = v;
  }
);

/** 协作时长：结束后用定格值，运行中用当前时间推算。 */
const elapsed = computed(() => {
  const t = props.turn;
  if (t.frozenMs != null) return t.frozenMs;
  if (t.startedAt && props.now != null) return props.now - t.startedAt;
  return null;
});

/** 折叠标题的思考段：有未闭合思考块时「思考中…」，否则报 frozenMs 合计。 */
const thoughtLabel = computed(() => {
  const thoughts = props.turn.process.filter((b): b is ThoughtBlock => b.type === 'thought');
  if (!thoughts.length) return null;
  if (thoughts.some((t) => !t.closed)) return '思考中…';
  let total = 0;
  for (const t of thoughts) total += t.frozenMs ?? 0;
  // 合计为 0（如回放块无计时基准）不报假数据
  return total > 0 ? '已思考 ' + fmtDuration(total) : null;
});

/** 折叠标题：「已工作 N 秒 · 已思考 N 秒 · N 次工具调用」；都没有则「工作过程」。 */
const label = computed(() => {
  const parts: string[] = [];
  const ms = elapsed.value;
  if (ms != null) parts.push('已工作 ' + fmtDuration(ms));
  const thought = thoughtLabel.value;
  if (thought) parts.push(thought);
  if (props.turn.toolCount) parts.push(props.turn.toolCount + ' 次工具调用');
  return parts.length ? parts.join(' · ') : '工作过程';
});

/** 等待权限时折叠标题给出明确状态，避免把权限伪装成普通工具完成。 */
const waiting = computed(() => props.turn.status === 'waiting-permission');

function toggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="work-divider">
    <button
      type="button"
      class="work-btn"
      :class="{ open: expanded }"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="panelId"
      @click="toggle"
    >
      <span>{{ waiting ? '等待确认…' : label }}</span>
      <span class="wr-chev" v-html="ICON_CHEV_DOWN" />
    </button>
  </div>

  <div :id="panelId" class="wr-panel" :class="{ open: expanded }">
    <div class="wr-panel-in">
      <!-- 惰性渲染：折叠面板的内容不进 DOM。一个长会话动辄上千工具行，
           全部渲染（哪怕 CSS 折叠不可见）会把 DOM 撑到 2 万+ 节点，
           任何一次更新/滚动都要在整个子树上做协调 —— 实测卡顿主因。
           运行中回合 expanded 自动为 true，流式内容照常实时出现。 -->
      <div v-if="expanded" class="wr-rows">
        <button
          v-if="hasEarlierProcess"
          type="button"
          class="wr-more"
          @click="showEarlierProcess"
        >
          显示更早的工作过程（还剩 {{ turn.process.length - visibleProcess.length }} 条）
        </button>
        <template v-for="b in visibleProcess" :key="b.id">
          <!-- 过程叙述：实时淡入；已封口（工具调用切断）的块不再重播动画 -->
          <MarkdownBlock
            v-if="b.type === 'text'"
            class="wr-text"
            :class="{ 'stream-in': !b.replay }"
            :raw="b.raw"
          />
          <!-- 思考块：次级样式与过程叙述区分；回放块无淡入 -->
          <MarkdownBlock
            v-else-if="b.type === 'thought'"
            class="wr-thought"
            :class="{ 'stream-in': !b.replay }"
            :raw="b.raw"
          />
          <!-- 已定稿回合不再需要秒级时钟：传常量 undefined，
               让全部历史工具行退出每秒一次的重渲染 -->
          <ToolCallRow v-else :block="b" :now="turn.settled ? undefined : now" />
        </template>
      </div>
    </div>
  </div>
</template>
