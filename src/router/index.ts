import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/games', name: 'games', component: () => import('@/views/GamesView.vue') },
    { path: '/game/:slug', name: 'detail', component: () => import('@/views/DetailView.vue') },
    { path: '/play/:slug', name: 'play', component: () => import('@/views/PlayView.vue') },
    { path: '/check', name: 'check', component: () => import('@/views/CheckView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
