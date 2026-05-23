from html.parser import HTMLParser

class MyHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        
    def handle_starttag(self, tag, attrs):
        if tag not in ['img', 'br', 'hr', 'input', 'meta', 'link']:
            self.tags.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if not self.tags:
            print(f"Error: Closing tag <{tag}> at {self.getpos()} with empty stack")
            return
        last_tag, pos = self.tags.pop()
        if last_tag != tag:
            print(f"Error: Mismatched tag. Expected </{last_tag}> (from {pos}), got </{tag}> at {self.getpos()}")

parser = MyHTMLParser()
with open('index.html', 'r') as f:
    parser.feed(f.read())
print("Unclosed tags:", parser.tags)
