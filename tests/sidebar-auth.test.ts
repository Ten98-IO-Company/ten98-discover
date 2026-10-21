import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import { AuthLayout as SharedAuthLayout, AuthStory } from '@ten98/ui'
import { AppBrand } from '@ten98/ui/app'

async function loadAuthLayout() {
 const source=await readFile(new URL('../src/components/AuthLayout.tsx',import.meta.url),'utf8')
 const {code}=await transformWithOxc(source.replace(/^import[^\n]*\n/gm,'').replace(/export (const|function)/g,'$1'),'AuthLayout.tsx',{jsx:{runtime:'classic'}})
 return new Function('React','SharedAuthLayout','AuthStory','Brand',code+';return AuthLayout;')(React,SharedAuthLayout,AuthStory,()=>React.createElement(AppBrand,{product:'Discover'}))
}

test('Discover shares auth presentation while preserving app-owned headings and native forms', async () => {
 const AuthLayout=await loadAuthLayout()
 const html=renderToStaticMarkup(React.createElement(AuthLayout,null,React.createElement('form',{className:'card auth',action:'/native-recovery',method:'post'},React.createElement('h1',null,'Recover account'),React.createElement('input',{name:'email',type:'email',required:true}),React.createElement('button',{type:'submit'},'Continue'))))
 assert.match(html,/t98-auth-layout/)
 assert.equal([...html.matchAll(/<main\b/g)].length,1)
 assert.equal([...html.matchAll(/<h1\b/g)].length,1)
 assert.match(html,/<h1>Recover account<\/h1>/)
 assert.match(html,/action="\/native-recovery" method="post"/)
 assert.match(html,/name="email"/)
 assert.match(html,/required=""/)
 assert.equal([...html.matchAll(/class="auth-orbit"/g)].length,1)
 assert.match(html,/Workspace access required\./)
})


test('Discover forwards shared auth title, description and footer without duplicating the heading', async () => {
 const AuthLayout=await loadAuthLayout()
 const html=renderToStaticMarkup(React.createElement(AuthLayout,{
  title:'Sign in', description:'Use your account to access your workspace.',
  footer:React.createElement('button',{type:'button'},'Forgot password?'),
 },React.createElement('form',{action:'/native-sign-in',method:'post'},React.createElement('input',{name:'email',type:'email',required:true}))))
 assert.equal([...html.matchAll(/<h1\b/g)].length,1)
 assert.match(html,/<h1 class="t98-auth-title">Sign in<\/h1>/)
 assert.match(html,/<p>Use your account to access your workspace\.<\/p>/)
 assert.match(html,/<footer class="auth-footnote"><button type="button">Forgot password\?<\/button><\/footer>/)
 assert.match(html,/action="\/native-sign-in" method="post"/)
})
