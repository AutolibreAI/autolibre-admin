import { createFileRoute, redirect } from '@tanstack/react-router'
import { SignOutButton } from '@clerk/tanstack-react-start'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'

/**
 * The landing spot for a valid AutoLibre account that is not staff.
 *
 * This exists as its own route instead of an error boundary because "signed in,
 * not an admin" is an EXPECTED state, not a failure: every app user has a valid
 * session, and most of them are not admins. Sending them back to /login would
 * loop — they are already signed in — and throwing an error would log noise for
 * something entirely normal.
 */
export const Route = createFileRoute('/sin-acceso')({
  beforeLoad: ({ context }) => {
    // Don't strand an admin here if they land on the URL directly.
    if (context.user?.role === 'admin') throw redirect({ to: '/dashboard' })
  },

  head: () => ({ meta: [{ title: 'Sin acceso — AutoLibre' }] }),
  component: NoAccess,
})

function NoAccess() {
  const { user } = Route.useRouteContext()

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="font-heading text-2xl font-bold tracking-tight">
        Auto<span className="text-brand">Libre</span>
      </div>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Panel de administración</p>

      <Card>
        <CardContent className="pt-6">
          <h1 className="text-base font-semibold">Esta cuenta no tiene acceso</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {user ? (
              <>
                Estás dentro como <span className="font-medium text-foreground">{user.email}</span>,
                pero el panel requiere rol <span className="font-medium text-foreground">admin</span>.
              </>
            ) : (
              <>El panel requiere una cuenta con rol admin.</>
            )}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Si creés que es un error, pedile a alguien del equipo que revise tu rol.
          </p>

          <SignOutButton redirectUrl="/">
            <Button variant="outline" size="sm" className="mt-4">
              Cerrar sesión y entrar con otra cuenta
            </Button>
          </SignOutButton>
        </CardContent>
      </Card>
    </main>
  )
}
