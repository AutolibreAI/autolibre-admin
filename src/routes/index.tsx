import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'

export const Route = createFileRoute('/')({
  /**
   * The only route signed-out visitors see, so it is the one that benefits most
   * from full SSR: real HTML on first byte, no auth flash. `ssr` is inherited
   * from `defaultSsr: true` in src/start.ts.
   */
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/dashboard' })
  },

  head: () => ({ meta: [{ title: 'AutoLibre — Panel' }] }),
  component: Landing,
})

function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="font-heading text-3xl font-bold tracking-tight">
        Auto<span className="text-brand">Libre</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Panel de administración</p>

      <Button asChild className="mt-8 w-fit">
        <Link to="/login">Iniciar sesión</Link>
      </Button>
    </main>
  )
}
