"""Small interactive TUI for manual smoke tests; press q to leave."""
import curses


def demo(screen):
    curses.curs_set(0)
    while True:
        screen.erase()
        height, width = screen.getmaxyx()
        rows = [
            'SIDETERM TUI_READY',
            'Terminal interactiva real',
            'Resize: %s columnas x %s filas' % (width, height),
            'Pulsa q para salir; otras teclas repintan la pantalla.',
        ]
        for i, text in enumerate(rows):
            if i < height:
                screen.addnstr(i, 0, text, max(0, width - 1))
        screen.refresh()
        if screen.getch() in (ord('q'), ord('Q')):
            return


if __name__ == '__main__':
    curses.wrapper(demo)
    print('TUI_EXIT_OK')
