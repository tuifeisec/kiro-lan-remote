<script setup lang="ts">
/**
 * 工作区卡片：可折叠，含路径、更新时间、会话数与「在此新建」。
 *
 * 展开后若卡片超出可视区，平滑滚入（与原实现一致的细节）。
 */
import { computed, ref, watch } from 'vue';
import type { WorkspaceGroup } from '../../stores/session.ts';
import type { SessionSummary } from '../../protocol/types.ts';
import { formatRelative } from '../../utils/time';
import { ICON_CHEV_DOWN, ICON_FOLDER, ICON_PLUS } from '../../assets/icons';
import SessionRow from './SessionRow.vue';

const props = defineProps<{
  group: WorkspaceGroup;
  /** 是否默认展开（最近更新的工作区默认展开）。 */
  defaultExpanded: boolean;
  /** 全局「全部收起」的触发计数：变化即强制收起。 */
  collapseTick: number;
}>();

const emit = defineEmits<{
  (e: 'open', session: SessionSummary): void;
  (e: 'new-session', cwd: string): void;
}>();

const expanded = ref(props.defaultExpanded);
const cardEl = ref<HTMLElement | null>(null);

/** 折叠按钮与任务列表的关联 id（分组键含盘符/反斜杠，需转成合法 id）。 */
const listId = computed(() => 'ws-tasks-' + props.group.key.replace(/[^a-zA-Z0-9_-]/g, '_'));

// 全局收起：所有卡片一起折叠
watch(
  () => props.collapseTick,
  () => {
    expanded.value = false;
  }
);

function toggle(): void {
  expanded.value = !expanded.value;
  if (!expanded.value) return;
  // 展开后若卡片超出可视区，平滑滚入
  requestAnimationFrame(() => {
    const card = cardEl.value;
    if (!card) return;
    const cr = card.getBoundingClientRect();
    const content = document.querySelector('.content');
    if (!content) return;
    const br = content.getBoundingClientRect();
    if (cr.bottom > br.bottom + 4 || cr.top < br.top - 4) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}
</script>

<template>
  <div ref="cardEl" class="ws-card" :class="{ expanded }">
    <div class="ws-head">
      <button
        type="button"
        class="ws-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-controls="listId"
        @click="toggle"
      >
        <span class="ws-icon" v-html="ICON_FOLDER" />
        <span class="ws-body">
          <span class="ws-title-row">
            <span class="ws-name" :title="group.name">{{ group.name }}</span>
            <span class="pill">本地</span>
          </span>
          <span class="ws-path" :title="group.cwd">{{ group.cwd }}</span>
          <span v-if="formatRelative(group.items[0]?.updatedAt)" class="ws-updated">
            更新于 {{ formatRelative(group.items[0]?.updatedAt) }}
          </span>
        </span>
        <span class="ws-count">
          <span>{{ group.items.length }} 个会话</span>
          <span v-html="ICON_CHEV_DOWN" />
        </span>
      </button>

      <button
        type="button"
        class="add-btn"
        title="在此工作区新建会话"
        aria-label="在此工作区新建会话"
        @click.stop="emit('new-session', group.cwd)"
      >
        <span v-html="ICON_PLUS" />
      </button>
    </div>

    <ul :id="listId" class="ws-tasks">
      <SessionRow
        v-for="s in group.items"
        :key="s.sessionId"
        :session="s"
        @open="(session) => emit('open', session)"
      />
    </ul>
  </div>
</template>
