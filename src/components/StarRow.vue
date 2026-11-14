<script setup lang="ts">
defineProps<{ stars: number; size?: number }>()
</script>

<template>
  <div class="flex items-center justify-center gap-2">
    <svg
      v-for="i in 3"
      :key="i"
      :width="size || 36"
      :height="size || 36"
      viewBox="0 0 24 24"
      :class="i <= stars ? 'drop-shadow-[0_4px_10px_rgba(255,197,61,.45)]' : ''"
    >
      <path
        d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95L12 2.6z"
        :fill="i <= stars ? '#ffc53d' : '#e6ebf5'"
        :stroke="i <= stars ? '#f0a800' : '#d7dfee'"
        stroke-width="1"
      />
    </svg>
  </div>
</template>
