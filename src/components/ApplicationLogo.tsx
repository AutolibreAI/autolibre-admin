import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { applicationLogoUrl } from '~/lib/application-logo'

export function ApplicationLogo({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false)
  const logo = applicationLogoUrl(url)
  if (!logo) return null
  return (
    <Card className="mb-4 shadow-none">
      <CardHeader>
        <CardTitle>Logo adjunto</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        {failed ? (
          <div className="flex size-24 items-center justify-center rounded-lg border bg-muted">
            <ImageOff className="size-6 text-muted-foreground" aria-hidden />
          </div>
        ) : (
          <img
            src={logo}
            alt={'Logo de ' + name}
            width={96}
            height={96}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-24 rounded-lg border bg-background object-contain p-2"
            onError={() => setFailed(true)}
          />
        )}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {failed
              ? 'No pudimos cargar la vista previa del logo.'
              : 'Imagen enviada por el proveedor con su solicitud.'}
          </p>
          <Button asChild variant="link" className="min-h-11 self-start px-0">
            <a href={logo} target="_blank" rel="noopener noreferrer">
              Abrir logo en tamaño completo
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
