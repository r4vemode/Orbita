import unittest
import os
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from bridge import classify, convert, data_directory, atomic_write

class BridgeTest(unittest.TestCase):
    def test_positive(self):
        row=classify('Сбер: чистая прибыль выросла на 10%')
        self.assertEqual(row['sentiment'], 'positive')
        self.assertEqual(row['sentimentAsset'], 'SBER')
    def test_negative(self):
        self.assertEqual(classify('Лукойл: прибыль снизилась')['sentiment'], 'negative')
    def test_ambiguous(self):
        for text in ['Сбер: прибыль не выросла', 'Сбер и Лукойл: прибыль выросла', 'Сбер: ожидается рост прибыли', 'Биткоин вырос']:
            self.assertEqual(classify(text)['sentiment'], 'neutral')
    def test_identity_and_limit(self):
        m=SimpleNamespace(id=123, message='Сбер '+('я'*400), date=datetime.now(timezone.utc))
        a=convert(m, 55, 'markettwits')
        self.assertLessEqual(len(a['title']),280)
        self.assertEqual(a['id'],'tg:55:123')
        m.message='Исправлено'
        self.assertEqual(convert(m,55,'markettwits')['id'],a['id'])
    def test_no_text(self):
        self.assertIsNone(convert(SimpleNamespace(message=''),55,'markettwits'))
    def test_server_data_directory_is_respected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            target=root/'private'/'configured-data'
            self.assertEqual(data_directory({'ORBITA_DATA_DIR':str(target)},root),target)
            self.assertTrue(target.is_dir())
            self.assertFalse((root/'data').exists())
            if os.name!='nt': self.assertEqual(target.stat().st_mode&0o777,0o700)
    def test_public_or_symbolic_data_locations_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); public=root/'public'; public.mkdir()
            for target in (public,public/'nested'):
                with self.assertRaises(ValueError): data_directory({'ORBITA_DATA_DIR':str(target)},root)
            target=root/'private'; target.mkdir(mode=0o700)
            alias=root/'alias'; alias.symlink_to(target,target_is_directory=True)
            with self.assertRaises(ValueError): data_directory({'ORBITA_DATA_DIR':str(alias)},root)
            (target/'news.json').symlink_to(root/'outside-feed')
            with self.assertRaises(ValueError): data_directory({'ORBITA_DATA_DIR':str(target)},root)
    def test_failed_feed_serialization_preserves_previous_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            target=Path(temporary)/'news.json'; target.write_text('previous-feed')
            with self.assertRaises(TypeError): atomic_write(target,{'unsupported':object()})
            self.assertEqual(target.read_text(),'previous-feed')
            self.assertEqual(list(target.parent.iterdir()),[target])

if __name__=='__main__': unittest.main()
